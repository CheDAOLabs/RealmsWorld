import { NextResponse } from "next/server";
import { hash, shortString, uint256 } from "starknet";

import { db, eq, schema } from "@realms-world/db";

import { getTokenContractAddresses } from "../utils/utils";
//import { Client } from "https://esm.sh/ts-postgres";

import { inngest } from "./client";

function eventKey(name: string) {
  const h = BigInt(hash.getSelectorFromName(name));
  return `0x${h.toString(16).padStart(64, "0")}`;
}

export const tokenURI = eventKey("tokenURI");
export const token_uri = eventKey("token_uri");

export const fetchMetadata = inngest.createFunction(
  { name: "fetchMetadata", id: "fetchMeta" },
  { event: "nft/mint" },
  async ({ event, step }) => {
    const metadataUrl = await step.run("Fetch token URL", () => {
      // TODO add variable for mainnet (maybe Alchemy?).
      return `https://starknet-goerli.infura.io/v3/badbe99a05ad427a9ddbbed9e002caf6`;
    });

    const metadata = await step.run("Fetch metadata", async () => {
      const tokenId = uint256.bnToUint256(
        BigInt(event.data.tokenId.toString()),
      );
      const response = await fetch(metadataUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "starknet_call",
          params: [
            {
              contract_address: event.data.contract_address,
              entry_point_selector:
                event.data.contract_address ==
                getTokenContractAddresses("beasts").L2
                  ? tokenURI
                  : token_uri, // Token URI
              calldata: [tokenId.low, tokenId.high],
            },
            "pending",
          ],
          id: 0,
        }),
      });
      return await response.json();
    });

    if (metadata.error) {
      console.log(metadata.error);
      await step.sleep("fetch sleep", "10s");
      throw new Error("Failed to fetch item from Infura API");
    }

    const value: any = [];
    for (let i = 2; i < metadata.result.length; i++) {
      const result = shortString.decodeShortString(metadata.result[i]);
      value.push(result);
    }

    const jsonString = value.join("");
    const regex = new RegExp("\\u0015", "g");
    const modifiedJsonString = jsonString
      .replace(
        /"name":"(.*?)"\,/g,
        (match: any, name: any) => `"name":"${name.replaceAll('"', '\\"')}",`,
      )
      .replace(regex, "");

    const parsedJson = JSON.parse(modifiedJsonString);

    const flattenedAttributes: Record<string, string> = {};

    if (parsedJson.attributes) {
      for (const attribute of parsedJson.attributes) {
        flattenedAttributes[attribute.trait_type] = attribute.value;
      }
    }

    const dbRes = await step.run(
      "Insert Beast Metadata to Postgres",
      async () => {
        const query = await db
          .update(schema.erc721Tokens)
          .set({
            image: parsedJson.image,
            name: parsedJson.name,
            metadata: { attributes: parsedJson.attributes },
          })
          .where(
            eq(
              schema.erc721Tokens.id,
              event.data.contract_address + ":" + event.data.tokenId,
            ),
          );

        /*const query = await sql(
        "insert or update rw_erc721_tokens set image = $1, metadata = $2, name=$3 where id = $4",
        [
          parsedJson.image,
          flattenedAttributes,
          parsedJson.name,
          event.data.contract_address + ":" + event.data.tokenId,
        ],
      );*/

        return query;
      },
    );
    return NextResponse.json({
      event,
      res: dbRes,
    });
  },
);
