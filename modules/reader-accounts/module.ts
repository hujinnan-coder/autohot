import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "reader-accounts",
  pages: [
    { path: "join", file: "web/join.tsx" },
    { path: "apply", file: "web/apply.tsx" },
    { path: "register", file: "web/register.tsx" },
    { path: "login", file: "web/login.tsx" },
    { path: "account", file: "web/account.tsx" },
    { path: "account/pending", file: "web/pending.tsx" },
    { path: "reader-applications", file: "web/reader-applications.tsx", admin: true, nav: "申请审批" },
    { path: "readers", file: "web/readers.tsx", admin: true, nav: "读者名单" },
    { path: "reader-invites", file: "web/reader-invites.tsx", admin: true, nav: "邀请码" },
  ],
  apiPaths: [/^\/api\/reader\//, /^\/api\/admin\/(readers|reader-invites|reader-applications)(\/|$)/, /^\/api\/admin\/reader-lookups$/],
});
