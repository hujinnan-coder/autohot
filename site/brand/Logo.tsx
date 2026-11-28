// 站点的字标和圆环标记：页面用 Wordmark 画站名（size 是高度，单位像素），RingMark 是小标记，转起来就是加载动画。
// Wordmark 是 AUTOHOT 的字母变形（SVG）；换站名时重新画一份，保持同样的参数。
import { SITE } from "../site.ts";

/** 字标：AUTOHOT 宽扁几何字形（参考埃安字母标），笔画顶端斜切，A 平顶带横杠，HOT 的 O 内嵌“热点”圆点。字母随文字颜色，圆点用强调色。 */
export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  const glyphs: Record<string, string> = {
    A: "M0 86L34 0H46L80 86H58L40 40.4L22 86ZM16 56H64V76H16Z",
    U: "M0 4V46A40 40 0 0 0 80 46V0L60 4V46A20 20 0 0 1 40 66A20 20 0 0 1 20 46V0Z",
    T: "M0 0H80L76 20H4ZM30 10H50V86H30Z",
    O: "M34 0H46A34 34 0 0 1 80 34V52A34 34 0 0 1 46 86H34A34 34 0 0 1 0 52V34A34 34 0 0 1 34 0ZM34 20H46A14 14 0 0 1 60 34V52A14 14 0 0 1 46 66H34A14 14 0 0 1 20 52V34A14 14 0 0 1 34 20Z",
    H: "M0 4L20 0V86H0ZM60 4L80 0V86H60ZM18 37H62V55H18Z",
  };
  return (
    <svg viewBox="-8 -8 630 102" height={size} width={Math.round((size * 630) / 102)} className={className} aria-label={title} role="img">
      {["A", "U", "T", "O", "H", "O", "T"].map((l, i) => (
        <path key={i} transform={`translate(${i * 89} 0)`} d={glyphs[l]} fill="currentColor" fillRule={l === "O" ? "evenodd" : undefined} />
      ))}
      <circle cx="485" cy="43" r="11.5" className="fill-accent" />
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
