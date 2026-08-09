# Sera Protocol GraphQL API Reference

## Endpoint

```
POST https://api.goldsky.com/api/public/project_cmicv6kkbhyto01u3agb155hg/subgraphs/sera-pro/1.0.9/gn
```

- **Authentication**: None required (public endpoint)
- **Rate Limits**: 50 queries / 10 seconds, max 1000 complexity, max 1000 results
- **Content-Type**: `application/json`

## Table of Contents
1. [Query Helper Function](#query-helper)
2. [Market Queries](#market-queries)
3. [Order Book Queries](#order-book-queries)
4. [User Order Queries](#user-order-queries)
5. [Chart/OHLCV Queries](#chart-queries)
6. [Token Queries](#token-queries)
7. [Query Operators](#query-operators)
8. [curl Examples](#curl-examples)

---

## Query Helper Function {#query-helper}

Standard pattern used across all modules:

```typescript
const SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_cmicv6kkbhyto01u3agb155hg/subgraphs/sera-pro/1.0.9/gn";

async function querySubgraph<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) {
    throw new Error(`Subgraph query error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}
```

---

## Market Queries {#market-queries}

### Get Single Market

```graphql
query GetMarket($id: ID!) {
  market(id: $id) {
    id
    quoteToken {
      id
      symbol
      decimals
    }
    baseToken {
      id
      symbol
      decimals
    }
    quoteUnit
    makerFee
    takerFee
    minPrice
    tickSpace
    latestPrice
    latestPriceIndex
  }
}
```

**Variables**: `{ "id": "0x002930b390ac7d686f07cffb9d7ce39609d082d1" }`

**Key fields**:
- `quoteUnit`: Multiplier for raw ↔ quote amount conversions
- `makerFee`: Basis points x100 (negative = rebate, e.g., -500 = -0.05%)
- `takerFee`: Basis points x100 (e.g., 1000 = 0.1%)
- `minPrice` / `tickSpace`: For calculating `price = minPrice + tickSpace * priceIndex`
- `latestPrice` / `latestPriceIndex`: Most recent trade price

### List Markets

```graphql
query ListMarkets($first: Int!) {
  markets(first: $first) {
    id
    quoteToken { id symbol decimals }
    baseToken { id symbol decimals }
    quoteUnit
    latestPrice
    latestPriceIndex
  }
}
```

**Variables**: `{ "first": 10 }`

---

## Order Book Queries {#order-book-queries}

### Get Depth (Bids + Asks)

```graphql
query GetDepth($market: String!, $first: Int!) {
  bids: depths(
    where: { market: $market, isBid: true, rawAmount_gt: "0" }
    orderBy: priceIndex
    orderDirection: desc
    first: $first
  ) {
    priceIndex
    price
    rawAmount
  }
  asks: depths(
    where: { market: $market, isBid: false, rawAmount_gt: "0" }
    orderBy: priceIndex
    orderDirection: asc
    first: $first
  ) {
    priceIndex
    price
    rawAmount
  }
}
```

**Variables**: `{ "market": "0x002930b390ac7d686f07cffb9d7ce39609d082d1", "first": 10 }`

**Notes**:
- Bids sorted descending (highest first = best bid)
- Asks sorted ascending (lowest first = best ask)
- Filter `rawAmount_gt: "0"` to exclude empty levels
- Typical depth: top 10 levels each side

---

## User Order Queries {#user-order-queries}

### Get User's Open Orders

```graphql
query GetOrders($user: String!, $market: String!, $first: Int!) {
  openOrders(
    where: { user: $user, market: $market }
    orderBy: createdAt
    orderDirection: desc
    first: $first
  ) {
    id
    market { id }
    priceIndex
    orderIndex
    isBid
    rawAmount
    rawFilledAmount
    claimableAmount
    status
  }
}
```

**Variables**:
```json
{
  "user": "0xYourAddress",
  "market": "0x002930b390ac7d686f07cffb9d7ce39609d082d1",
  "first": 50
}
```

**Order status values**: `"open"`, `"partial"`, `"filled"`, `"cancelled"`, `"claimed"`, `"pending"`

**Key fields for claiming**:
- `orderIndex`: Needed for the claim transaction
- `priceIndex`: Needed for the claim transaction
- `isBid`: Direction needed for claim
- `claimableAmount`: Amount ready to claim (> 0 means claimable)
- `rawFilledAmount`: How much has been filled so far

---

## Chart Queries {#chart-queries}

### Get OHLCV Candlestick Data

```graphql
query GetChartLogs($market: String!, $intervalType: String!, $first: Int!) {
  chartLogs(
    where: { market: $market, intervalType: $intervalType }
    orderBy: timestamp
    orderDirection: desc
    first: $first
  ) {
    timestamp
    open
    high
    low
    close
    volume
    intervalType
  }
}
```

**Interval Types**: `"1m"`, `"5m"`, `"15m"`, `"1h"`, `"4h"`, `"1d"`, `"1w"`

---

## Token Queries {#token-queries}

### List Available Tokens

```graphql
query ListTokens($first: Int!) {
  tokens(first: $first) {
    id
    symbol
    decimals
  }
}
```

---

## Query Operators {#query-operators}

The Goldsky subgraph supports standard Graph Protocol operators:

| Operator | Example | Description |
|---|---|---|
| `first` | `first: 10` | Limit results |
| `skip` | `skip: 20` | Offset for pagination |
| `orderBy` | `orderBy: priceIndex` | Sort field |
| `orderDirection` | `orderDirection: asc` | Sort direction |
| `where` | `where: { market: "0x..." }` | Filter |
| `_gt` / `_gte` | `rawAmount_gt: "0"` | Greater than |
| `_lt` / `_lte` | `priceIndex_lt: 100` | Less than |
| `_in` | `status_in: ["open","partial"]` | In list |

---

## curl Examples {#curl-examples}

### List Markets
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ markets(first: 5) { id quoteToken { symbol } baseToken { symbol } latestPrice } }"}' \
  https://api.goldsky.com/api/public/project_cmicv6kkbhyto01u3agb155hg/subgraphs/sera-pro/1.0.9/gn | jq
```

### Get Order Book
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ bids: depths(where: {market: \"0x002930b390ac7d686f07cffb9d7ce39609d082d1\", isBid: true, rawAmount_gt: \"0\"}, orderBy: priceIndex, orderDirection: desc, first: 5) { priceIndex price rawAmount } asks: depths(where: {market: \"0x002930b390ac7d686f07cffb9d7ce39609d082d1\", isBid: false, rawAmount_gt: \"0\"}, orderBy: priceIndex, orderDirection: asc, first: 5) { priceIndex price rawAmount } }"}' \
  https://api.goldsky.com/api/public/project_cmicv6kkbhyto01u3agb155hg/subgraphs/sera-pro/1.0.9/gn | jq
```

### Get User Orders
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ openOrders(where: {user: \"0xYourAddress\", market: \"0x002930b390ac7d686f07cffb9d7ce39609d082d1\"}, first: 10) { id priceIndex isBid rawAmount status claimableAmount } }"}' \
  https://api.goldsky.com/api/public/project_cmicv6kkbhyto01u3agb155hg/subgraphs/sera-pro/1.0.9/gn | jq
```
