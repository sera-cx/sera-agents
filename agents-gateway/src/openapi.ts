export const OPENAPI_DOC = {
  openapi: "3.1.0",
  info: {
    title: "Sera Protocol API",
    version: "1.0.0",
    description: "On-chain FX settlement for multi-currency stablecoins.",
    contact: { email: "partnerships@sera.cx" },
  },
  servers: [{ url: "https://agents.sera.cx" }],
  paths: {
    "/quote": {
      post: {
        operationId: "fx_quote",
        summary: "Get a live FX quote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["from_token", "to_token", "amount"],
                properties: {
                  from_token: { type: "string", example: "XSGD" },
                  to_token: { type: "string", example: "IDRX" },
                  amount: { type: "string", description: "Amount in from_token units" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Quote result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    amount_out: { type: "string" },
                    mid_rate: { type: "string" },
                    network_cost: { type: "string" },
                    quote_id: { type: "string" },
                    expires_at: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/settle": {
      post: {
        operationId: "fx_settle",
        summary: "Build an unsigned settlement transaction from a quote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["quote_id", "signer"],
                properties: {
                  quote_id: { type: "string" },
                  signer: { type: "string", description: "Caller wallet address" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Unsigned EIP-712 transaction",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    typed_data: {
                      type: "object",
                      description: "EIP-712 typed data for wallet signing",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/corridors": {
      get: {
        operationId: "corridors",
        summary: "List supported FX corridors",
        responses: {
          "200": {
            description: "Corridor list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      from_currency: { type: "string" },
                      to_currency: { type: "string" },
                      liquidity_depth: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/rates": {
      get: {
        operationId: "rates",
        summary: "Fetch live FX reference rates",
        parameters: [
          {
            in: "query",
            name: "pairs",
            schema: { type: "string" },
            description: "Comma-separated currency pairs, e.g. USDC/BRLA,XSGD/IDRX",
            required: true,
          },
        ],
        responses: {
          "200": {
            description: "Rate snapshot",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      pair: { type: "string" },
                      mid_rate: { type: "string" },
                      bid: { type: "string" },
                      ask: { type: "string" },
                      timestamp: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
