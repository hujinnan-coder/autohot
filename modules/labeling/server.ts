// The labeling page's data and commands, for the engine's admin (writes carry its CSRF token).
import { defineServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { adminHandler } from "@aihot/api/routes/admin-auth";
import { sendProblem } from "@aihot/api/http/respond";
import { labelingPage, markArticle, unmarkArticle } from "./backend/marks.ts";

const BASE = "/api/admin/labeling";

export default defineServerModule({
  name: "labeling",
  http(app) {
    app.get(BASE, adminHandler(async (req, _reply, admin) => labelingPage(req.query as Record<string, string>, admin.csrf)));
    app.put(`${BASE}/:id`, adminHandler(async (req, reply, admin) => {
      const ok = await markArticle((req.params as { id: string }).id, req.body ?? {}, actorOf(admin));
      return ok ? { ok } : sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这条资料。" });
    }));
    app.delete(`${BASE}/:id`, adminHandler(async (req, reply) => {
      const ok = await unmarkArticle((req.params as { id: string }).id);
      return ok ? { ok } : sendProblem(req, reply, { status: 404, code: "not_found", detail: "这条还没有标注。" });
    }));
  },
});
