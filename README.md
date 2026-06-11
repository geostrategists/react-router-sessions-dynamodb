# AWS DynamoDB Session Storage for React Router

This package provides a session storage implementation for React Router that uses AWS DynamoDB to store session data.

## Installation

```bash
npm install @geostrategists/react-router-sessions-dynamodb
```

## Prerequisites

- An AWS account with DynamoDB access
- A DynamoDB table with a primary key (partition key) for storing session IDs
- **Important**: Time-to-Live (TTL) must be enabled on the DynamoDB table for automatic session expiration
  - Configure the TTL attribute in the DynamoDB table settings

## Usage

```typescript
import { createDynamoDBSessionStorage } from "~/lib/sessions";

// Create a session storage instance with environment variables
const sessionStorage = createDynamoDBSessionStorage({
  table: process.env.DYNAMODB_TABLE_NAME,
  idx: "_idx",
  cookie: {
    // Configure with environment variables
  },
});

// Extract session functions
const { getSession, commitSession, destroySession } = sessionStorage;

// Use in a loader
export async function loader({ request }) {
  const session = await getSession(request.headers.get("Cookie"));

  // Work with session data
  const userData = session.get("userData");

  // Return data with the session cookie
  return json(
    { userData },
    {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    },
  );
}
```

## Configuration Options

### DynamoDBSessionStorageOptions

- `table` (required): The name of the DynamoDB table to store sessions
- `idx` (required): The name of the attribute used to store the session ID
- `ttl` (optional): The name of the TTL attribute
- `client` (optional): A pre-configured DynamoDBDocumentClient instance
- `cookie` (optional): Cookie configuration options
  - `name`: Cookie name
  - `secrets`: Array of secrets for signing the cookie
  - `sameSite`: SameSite attribute
  - `path`: Cookie path
  - `maxAge`: Cookie max age in seconds
  - `httpOnly`: HttpOnly attribute
  - `secure`: Secure attribute
  - `domain`: Cookie domain
- `sessionMaxAge` (optional): The max age of table entries when no cookie maxAge is set
- `indexes` (optional): Global secondary indexes on the sessions table, keyed by the session-data attribute they index (the attribute must be the index's partition key). Required for `deleteSessionsBy`.

### Deleting sessions by attribute

In addition to the standard `SessionStorage` functions, the returned storage exposes `deleteSessionsBy(attribute, value)`, which deletes all sessions whose `attribute` equals `value` and returns the number of deleted sessions. This requires a global secondary index on the attribute, configured via `indexes`:

```typescript
const sessionStorage = createDynamoDBSessionStorage({
  table: "sessions",
  idx: "_idx",
  indexes: { familyId: "familyId-index" },
});

// e.g. sign out all devices belonging to a revoked token family
await sessionStorage.deleteSessionsBy("familyId", familyId);
```

> [!NOTE]
> By default, react-router only sets session data to expire when the
> cookie has a maxAge (or expires date) set. When using session cookies,
> such an expiry time does not exist, and in theory, such cookies can be
> kept alive by the browser indefinitely.
>
> However, it can still be desired to let the session data in the table
> expire at some point in the near or distant future, which can be set
> with the `sessionMaxAge` property.

## DynamoDB Table Requirements

- Primary key: Must match the `idx` value
- TTL attribute: Must match the `ttl` value
- **Important**: TTL must be enabled on the table for automatic session expiration
