// 站点的字标和圆环标记：页面用 Wordmark 画站名（size 是高度，单位像素），RingMark 是小标记，转起来就是加载动画。
// Wordmark 是 AUTOHOT 的字母变形（SVG）；换站名时重新画一份，保持同样的参数。
import { SITE } from "../site.ts";

/** 字标：AUTOHOT 七个粗体字母，A 去掉横杠成 Λ，第二个 O 里的圆点是“热点”。字母随文字颜色，圆点用强调色。 */
export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="-8 -8 632 116" height={size} width={Math.round((size * 632) / 116)} className={className} aria-label={title} role="img">
      <path d="M0 100L28 0H48L76 100H54L38 30L22 100Z" fill="currentColor" />
      <path
        d="M101 0V63A27 27 0 0 0 155 63V0M180 11H256M218 0V100M308 11H308A27 27 0 0 1 335 38V62A27 27 0 0 1 308 89H308A27 27 0 0 1 281 62V38A27 27 0 0 1 308 11ZM371 0V100M425 0V100M371 50H425M488 11H488A27 27 0 0 1 515 38V62A27 27 0 0 1 488 89H488A27 27 0 0 1 461 62V38A27 27 0 0 1 488 11ZM540 11H616M578 0V100"
        fill="none"
        stroke="currentColor"
        strokeWidth="22"
      />
      <circle cx="488" cy="50" r="12" className="fill-accent" />
    </svg>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
