import { defineWebModule } from "@aihot/web/modules";
import { IconHeart } from "@aihot/web/components/icons";

export default defineWebModule({
  name: "following",
  // 电脑侧栏“内容”里收藏的后面；手机上放在“我的”页的工具行里。
  sidebar: { section: "内容", items: [{ to: "/following", label: "关注", icon: IconHeart }] },
  tools: [{ to: "/following", label: "关注", icon: <IconHeart size={20} /> }],
});
