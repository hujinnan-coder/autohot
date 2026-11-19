// 标注：站长给模型评过分的资料逐条标“该选 / 不该选 / 两可”，导出成精选评测的金标集（docs/selection.md 的“校准”）。
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "labeling",
  pages: [{ path: "labeling", file: "web/labeling.tsx", admin: true, nav: "标注" }],
});
