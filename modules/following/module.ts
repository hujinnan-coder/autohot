// 我的关注：读者选几个品牌，把它们的最新动态合成一条按时间排的信息流。第一版不用登录，关注的品牌存在这个浏览器里。
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "following",
  pages: [{ path: "following", file: "web/following.tsx" }],
});
