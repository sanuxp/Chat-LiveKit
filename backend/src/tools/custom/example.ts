import type { ToolHandler } from "../types.js";

/**
 * Example custom tool (tools.yaml: handler: custom, module: example).
 * Drop another file in this folder, default-export a ToolHandler, and reference it by file name.
 * Do NOT log `args` — they may contain customer data.
 */
const handler: ToolHandler = {
  async execute(args, ctx) {
    const orderNumber = String(args.order_number ?? "");
    ctx.log.info("lookup_order called"); // log that it ran, not what was asked
    // Replace with a real lookup (database, internal API, ...). Fake data for the demo:
    return {
      ok: true,
      llmResult: {
        order_number: orderNumber,
        status: "shipped",
        carrier: "ExampleExpress",
        eta: "2 business days",
      },
    };
  },
};

export default handler;
