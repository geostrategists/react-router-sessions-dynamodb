import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { createSessionStorage } from "react-router";

import type { BatchWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { FlashSessionData, SessionData, SessionIdStorageStrategy, SessionStorage } from "react-router";

interface DynamoDBSessionStorageOptions<Indexes extends string = string> {
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
   * The max amount of seconds an entry will be stored if no expiry date is set in createData/updateData.
   * This can be useful if you want your table data to expire after a certain amount of time, even when using
   * session cookies (that don't specify a maxAge or expires date).
   * If absent, only the `expires` date passed to #createData/#updateData (i.e. the maxAge of the cookie)
   * will result in TTL being set.
   */
  sessionMaxAge?: number;

  /**
   * Optional DynamoDB client to use instead of creating a new one.
   */
  client?: DynamoDBDocumentClient | (() => DynamoDBDocumentClient);

  /**
   * Global secondary indexes on the sessions table, keyed by the session-data
   * attribute they index (the attribute must be the index's partition key).
   * Required for #deleteSessionsBy.
   */
  indexes?: Partial<Record<Indexes, string>>;
}

export interface DynamoDBSessionStorage<
  Data = SessionData,
  FlashData = Data,
  Indexes extends keyof Data & string = keyof Data & string,
> extends SessionStorage<Data, FlashData> {
  /**
   * Deletes all sessions whose `attribute` equals `value`. The attribute must
   * be configured as an index in the storage options.
   * Returns the number of deleted sessions.
   */
  deleteSessionsBy<A extends Indexes>(attribute: A, value: NonNullable<Data[A]> & (string | number)): Promise<number>;
}

const MAX_BATCH_WRITE_RETRIES = 5;

/**
 * Session storage using a DynamoDB table.
 *
 * Requires a DynamoDB table with the following structure:
 * - Primary key: `id` (string)
 * - Optional TTL attribute (defaults to "_ttl")
 */
export function createDynamoDBSessionStorage<
  Data = SessionData,
  FlashData = Data,
  Indexes extends keyof Data & string = keyof Data & string,
>({ cookie, ...props }: DynamoDBSessionStorageOptions<Indexes>): DynamoDBSessionStorage<Data, FlashData, Indexes> {
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

  const setTTL = (params: Record<string, unknown>, expires: Date | undefined) => {
    if (props.ttl) {
      if (props.sessionMaxAge) {
        expires ??= new Date(Date.now() + props.sessionMaxAge * 1000);
      }
      params[props.ttl] = expires ? Math.round(expires.getTime() / 1000) : undefined;
    }
  };

  const deleteSessionsBy = async (attribute: Indexes, value: string | number): Promise<number> => {
    const indexName = props.indexes?.[attribute];
    if (!indexName) {
      throw new Error(`No index configured for attribute "${attribute}"`);
    }

    let deleted = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await getClient().send(
        new QueryCommand({
          TableName: props.table,
          IndexName: indexName,
          KeyConditionExpression: "#attr = :value",
          ExpressionAttributeNames: { "#attr": attribute, "#idx": props.idx },
          ExpressionAttributeValues: { ":value": value },
          ProjectionExpression: "#idx",
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      lastEvaluatedKey = result.LastEvaluatedKey;

      const keys = (result.Items ?? []).map((item) => ({ [props.idx]: item[props.idx] }));
      for (let i = 0; i < keys.length; i += 25) {
        let requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] = keys
          .slice(i, i + 25)
          .map((key) => ({ DeleteRequest: { Key: key } }));
        for (let attempt = 0; requests.length > 0; attempt++) {
          if (attempt > 0) {
            if (attempt > MAX_BATCH_WRITE_RETRIES) {
              throw new Error(`Failed to delete ${requests.length} sessions after ${MAX_BATCH_WRITE_RETRIES} retries`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
          }
          const batchResult = await getClient().send(
            new BatchWriteCommand({ RequestItems: { [props.table]: requests } }),
          );
          const unprocessed = batchResult.UnprocessedItems?.[props.table] ?? [];
          deleted += requests.length - unprocessed.length;
          requests = unprocessed;
        }
      }
    } while (lastEvaluatedKey);

    return deleted;
  };

  const sessionStorage = createSessionStorage<Data, FlashData>({
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
          ...data,
          [props.idx]: id,
        };
        setTTL(params, expires);

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
      setTTL(params, expires);
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

  return { ...sessionStorage, deleteSessionsBy };
}
