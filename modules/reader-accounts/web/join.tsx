import { Link, useLoaderData } from "react-router";
import type { ReaderPreview } from "@aihot/contracts/reader";
import { SITE } from "@aihot/site";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import type { Screen } from "@aihot/web/components/shell/screens";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { apiGet, READER_WALL_ENABLED } from "@aihot/web/lib/api.server";
import { SampleCard, textLink } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { name: "入座", standalone: true };

export function meta() {
  return [{ title: `${SITE.name} · 汽车行业早晚两报` }, { name: "robots", content: "noindex, nofollow" }];
}

export async function loader({ request }: { request: Request }) {
  if (!READER_WALL_ENABLED) return { samples: [] };
  const result = await apiGet<{ samples: ReaderPreview[] }>("/api/reader/landing-samples", { signal: request.signal }).catch(() => null);
  const samples = Array.isArray(result?.samples) ? result.samples.slice(0, 2) : [];
  return { samples: samples.map(({ title, summary }) => ({ title, summary })) };
}

export default function JoinPage() {
  const { samples } = useLoaderData<typeof loader>();
  return (
    <div className="mx-auto w-full max-w-2xl px-[var(--gutter-l)] pb-16 pt-12 lg:pt-20">
      <Wordmark size={28} className="text-ink" />
      <p className="mt-10 text-[13px] font-medium text-ink-3">汽车行业 · 早晚两报</p>
      <h1 data-page-title="" className="mt-3 text-[32px] font-semibold leading-tight text-ink lg:text-[40px]">早上看去向，夜里听余声</h1>
      <p className="mt-4 max-w-lg text-[16px] leading-relaxed text-ink-2">同一件事，众家说法，并作一处。早报定今天的视线，晚报留给桌边的闲话。</p>
      <ul className="mt-7 space-y-2 border-y border-line py-5 text-[14px] leading-relaxed text-ink-3">
        <li>清晨一份，今天该盯什么，一页说完。</li>
        <li>入夜一份，这一天的热闹，收成可以聊的话。</li>
        <li>同一件事只留一处，重复的喧哗不占你的时间。</li>
      </ul>
      {samples.length > 0 && <div className="mt-8 grid gap-3 sm:grid-cols-2">{samples.map((sample, i) => <SampleCard key={i} {...sample} />)}</div>}
      <p className="mt-8 max-w-lg text-[14px] leading-relaxed text-ink-2">我们是一家独立运营了几年的公司，这份简报暂时只请受邀的朋友来读。若你也在这一行，欢迎来坐坐。</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link to="/register" className={buttonClass("primary", "lg")}>凭邀请码入座</Link>
        <Link to="/apply" className={buttonClass("secondary", "lg")}>申请入座</Link>
      </div>
      <p className="mt-6 text-[13px] text-ink-3">已有座位？<Link to="/login" className={textLink}>登录</Link></p>
    </div>
  );
}
