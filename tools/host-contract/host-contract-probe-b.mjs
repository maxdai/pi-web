/**
 * 宿主契约探针 B（experiments/rpc-bridge）
 *
 * 与 probe A 配对：稍后调用 `ctx.ui.setTitle(...)`。若 A 的改写能看到这次调用，说明
 * `ctx.ui` 确实是 runner 的**单一共享可变对象**——这是 pi-web 桥接方案最关键的假设。
 */
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      ctx.ui.setTitle("host-contract-probe-b");
    } catch {
      /* ignore */
    }
  });
}
