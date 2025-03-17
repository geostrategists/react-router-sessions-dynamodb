import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { createSessionStorage } from "react-router";

import type {
  FlashSessionData,
  SessionData,
  SessionIdStorageStrategy,
  SessionStorage,
} from "react-router";

interface DynamoDBSessionStorageOptions {
  /**
   * The Cookie used to store the session id on the client, or options used
   * to automatically create one.
   */
  cookie?: SessionIdStorageStrategy["cookie"];

  /**
   * The name of the DynamoDB table to store sessions.
   */
  table: string;

  /**
   * The name of the DynamoDB attribute used to store the session ID.
   * This should be the table's partition key.
   */
  idx: string;

  /**
   * The name of the DynamoDB attribute used to store the expiration time.
   * If absent, then no TTL will be stored and session records will not expire.
   */
  ttl?: string;

  /**
   * Optional DynamoDB client to use instead of creating a new one.
   */
  client?: DynamoDBDocumentClient | (() => DynamoDBDocumentClient);
}

/**
 * Session storage using a DynamoDB table.
 *
 * Requires a DynamoDB table with the following structure:
 * - Primary key: `id` (string)
 * - Optional TTL attribute (defaults to "_ttl")
 */
export function createDynamoDBSessionStorage<Data = SessionData, FlashData = Data>({
  cookie,
  ...props
}: DynamoDBSessionStorageOptions): SessionStorage<Data, FlashData> {
  let _client: DynamoDBDocumentClient | undefined;
  const getClient = (): DynamoDBDocumentClient => {
    if (!_client) {
      if (props.client) {
        _client = typeof props.client === "function" ? props.client() : props.client;
      } else {
        _client = DynamoDBDocumentClient.from(new DynamoDBClient());
      }
    }
    return _client!;
  };

  return createSessionStorage({
    cookie,
    async createData(data, expires) {
      while (true) {
        const randomBytes = crypto.getRandomValues(new Uint8Array(8));
        // This storage manages an id space of 2^64 ids, which is far greater
        // than the maximum number of files allowed on an NTFS or ext4 volume
        // (2^32). However, the larger id space should help to avoid collisions
        // with existing ids when creating new sessions, which speeds things up.
        const id = [...randomBytes].map((x) => x.toString(16).padStart(2, "0")).join("");

        const params: Record<string, unknown> = {
          [props.idx]: id,
          ...data,
        };
        if (props.ttl) {
          params[props.ttl] = expires ? Math.round(expires.getTime() / 1000) : undefined;
        }

        try {
          await getClient().send(
            new PutCommand({
              TableName: props.table,
              Item: params,
              ConditionExpression: `attribute_not_exists(#idx)`,
              ExpressionAttributeNames: { [`#idx`]: props.idx },
            }),
          );
        } catch (e: unknown) {
          if (e instanceof ConditionalCheckFailedException) {
            // Retry if the id already exists
            continue;
          }
          throw e;
        }

        return id;
      }
    },
    async readData(id) {
      const result = await getClient().send(
        new GetCommand({
          TableName: props.table,
          Key: { [props.idx]: id },
        }),
      );

      const data = result.Item;
      if (data) {
        delete data[props.idx];
        if (props.ttl) delete data[props.ttl];
      }
      return data as FlashSessionData<Data, FlashData>;
    },
    async updateData(id, data, expires) {
      const params: Record<string, unknown> = {
        [props.idx]: id,
        ...data,
      };
      if (props.ttl) {
        params[props.ttl] = expires ? Math.round(expires.getTime() / 1000) : undefined;
      }
      await getClient().send(
        new PutCommand({
          TableName: props.table,
          Item: params,
        }),
      );
    },
    async deleteData(id) {
      await getClient().send(
        new DeleteCommand({
          TableName: props.table,
          Key: { [props.idx]: id },
        }),
      );
    },
  });
}
