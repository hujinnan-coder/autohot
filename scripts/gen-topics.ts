import { writeFileSync } from "node:fs";
const { ENTITIES } = await import(process.argv[2] + "/industry/taxonomy.ts");
const groups = [
  { key: "company", name: "品牌与公司", blurb: "按品牌、集团和供应链公司追踪新车、价格、销量与企业动态" },
  { key: "field", name: "方向", blurb: "按方向深挖：智能驾驶、动力电池、出海、价格战……" },
  { key: "genre", name: "内容类型", blurb: "按类型浏览：新车上市、政策法规、销量、舆情、人事……" },
];
// 集团页：汇总旗下品牌的 entity 标签。
const G: Array<[string, string, string[], string]> = [
  ["byd-group", "比亚迪集团", ["byd", "denza", "fangchengbao", "yangwang", "fudi"], "比亚迪集团全貌：比亚迪、腾势、方程豹、仰望和弗迪的全部动态。"],
  ["geely-group", "吉利系", ["geely", "lynkco", "zeekr", "volvo", "polestar", "lotus", "smart", "radar", "farizon"], "吉利控股旗下品牌全貌：吉利、领克、极氪、沃尔沃、极星、路特斯、smart 等。"],
  ["chery-group", "奇瑞集团", ["chery", "exeed", "jetour", "icar", "omoda", "luxeed"], "奇瑞集团全貌：奇瑞、星途、捷途、iCAR、欧萌达与智界。"],
  ["gwm-group", "长城汽车集团", ["gwm", "haval", "wey", "tank", "ora"], "长城汽车旗下品牌全貌：哈弗、魏牌、坦克、欧拉与长城皮卡。"],
  ["changan-group", "长安系", ["changan", "deepal", "avatr"], "长安汽车旗下品牌全貌：长安、启源、深蓝与阿维塔。"],
  ["saic-group", "上汽集团", ["saic", "roewe", "mg", "im", "maxus", "wuling", "baojun", "shangjie"], "上汽集团全貌：荣威、MG、智己、大通、五菱、宝骏与尚界。"],
  ["gac-group", "广汽集团", ["gac", "aion", "hyptec"], "广汽集团全貌：传祺、埃安与昊铂。"],
  ["faw-group", "一汽集团", ["faw", "hongqi", "bestune", "jiefang"], "中国一汽全貌：红旗、奔腾与解放。"],
  ["dongfeng-group", "东风集团", ["dongfeng", "voyah", "mengshi"], "东风汽车集团全貌：东风各品牌、岚图与猛士。"],
  ["baic-group", "北汽集团", ["baic", "arcfox", "xiangjie", "foton"], "北汽集团全貌：北京汽车、极狐、享界与福田。"],
  ["hima", "鸿蒙智行", ["huawei", "aito", "luxeed", "xiangjie", "maextro", "shangjie"], "华为与鸿蒙智行“五界”：问界、智界、享界、尊界、尚界，以及乾崑智驾和鸿蒙座舱。"],
  ["vw-group", "大众集团", ["volkswagen", "audi", "porsche", "bentley", "lamborghini"], "大众汽车集团全貌：大众、奥迪、保时捷、宾利与兰博基尼。"],
  ["bmw-group", "宝马集团", ["bmw", "mini", "rolls-royce"], "宝马集团全貌：宝马、MINI 与劳斯莱斯。"],
  ["toyota-group", "丰田集团", ["toyota", "lexus"], "丰田与雷克萨斯的全部动态。"],
  ["gm-group", "通用汽车集团", ["gm", "buick", "chevrolet", "cadillac"], "通用汽车与上汽通用：别克、雪佛兰与凯迪拉克。"],
  ["ford-group", "福特集团", ["ford", "lincoln"], "福特与林肯的全部动态。"],
  ["hyundai-group", "现代起亚", ["hyundai", "kia"], "现代汽车集团：现代、起亚与捷尼赛思。"],
];
const special: Record<string, string> = {
  byd: "比亚迪王朝、海洋两网的新车、价格与销量，以及比亚迪的技术发布、出海和企业动态。",
  tesla: "特斯拉的车型与价格调整、FSD 与 Robotaxi 进展、中国与全球市场表现，以及马斯克相关的公司动向。",
  huawei: "华为乾崑智驾、鸿蒙座舱和鸿蒙智行的合作模式、技术发布与渠道动态。",
  xiaomi: "小米汽车的新车、交付、产能与舆情，以及雷军相关的营销与回应。",
  catl: "宁德时代的电池技术、换电布局、客户定点、产能与财报。",
  cpca: "乘联会发布的周度与月度乘用车销量、市场分析和行业观点。",
  caam: "中汽协发布的产销数据、行业倡议与政策建议。",
};
const kind = (id: string) => ["catl","fudi","calb","gotion","eve","sunwoda","svolt","lg-energy"].includes(id) ? "的电池技术、客户定点、产能与企业动态。"
  : ["momenta","horizon","black-sesame","zhuoyu","deeproute","qcraft","hesai","robosense","nvidia","qualcomm","mobileye","desay-sv","ecarx","thundersoft"].includes(id) ? "在汽车智能化上的产品、量产定点、合作与企业动态。"
  : ["apollo","pony","weride","waymo","didi","ehang"].includes(id) ? "的无人驾驶与出行业务进展：运营范围、车队、牌照、事故与融资。"
  : ["bosch","continental","zf","denso","magna","fuyao","joyson","tuopu"].includes(id) ? "的零部件产品、客户与产能、业绩与企业动态。"
  : ["zhongsheng","yongda","guanghui"].includes(id) ? "的门店网络、经营业绩与渠道变化。"
  : ["autohome","dongchedi","yiche","guazi"].includes(id) ? "的平台业务、数据榜单与企业动态。"
  : ["teld","star-charge"].includes(id) ? "的充电网络、合作与企业动态。"
  : ["cada","catarc"].includes(id) ? "发布的数据、标准、测评与行业观点。"
  : ["jiefang","foton","sinotruk","shacman","yutong","farizon"].includes(id) ? "的商用车新品、销量、出海与企业动态。"
  : "的新车、价格、销量、营销与企业动态。";
const topics: any[] = [];
for (const [id, e] of Object.entries(ENTITIES) as any) {
  // 搜索框里搜这些词也能找到这个品牌，正文里出现时链到品牌页；三个字母以内的缩写容易误中，不收（BYD、NIO、BMW 除外）。
  const names = new Set([id, e.name, ...e.name.split("/").map((s: string) => s.trim())]);
  const aliases = (e.aliases as string[]).filter((a) => !names.has(a) && (!/^[A-Za-z.& ]{1,3}$/.test(a) || ["BYD", "NIO", "BMW"].includes(a)));
  if (id === "omoda") aliases.push("捷酷 / 欧萌达");
  topics.push({ slug: id, name: e.name, group: "company", entityId: id, ...(aliases.length ? { aliases } : {}), definition: special[id] ?? `${e.name}${kind(id)}` });
}
for (const [slug, name, ids, definition] of G) {
  for (const id of ids) if (!(id in ENTITIES)) throw new Error(`unknown ${id}`);
  topics.push({ slug, name, group: "company", tags: ids.map((id) => `entity:${id}`), definition });
}
const F: Array<[string, string, string[], string]> = [
  ["smart-driving", "智能驾驶", ["智能驾驶"], "辅助驾驶与自动驾驶：城区 NOA、端到端、L3 准入、事故与监管口径。"],
  ["cockpit", "智能座舱", ["智能座舱"], "车机系统、大模型上车、座舱芯片与交互体验的进展。"],
  ["battery", "动力电池", ["动力电池", "固态电池"], "电池技术与产业：快充、固态电池、成本、装机量与安全。"],
  ["chips", "汽车芯片", ["汽车芯片"], "智驾与座舱芯片、自研芯片、供应与管制。"],
  ["charging", "充电与换电", ["充电/换电"], "超充网络、换电站、充电标准与补能体验。"],
  ["bev", "纯电", ["纯电"], "纯电车型与纯电市场的动态。"],
  ["phev", "插混与增程", ["插混/增程"], "插电混动与增程车型、技术路线之争与市场份额。"],
  ["ice", "燃油车", ["燃油车"], "燃油车的新品、价格、份额与转型。"],
  ["robotaxi", "Robotaxi", ["Robotaxi"], "无人驾驶出租车的运营范围、车队规模、牌照、事故与商业化。"],
  ["evtol", "飞行汽车", ["飞行汽车"], "飞行汽车与低空出行：适航取证、订单、试飞与量产。"],
  ["embodied", "具身智能", ["具身智能"], "车企造机器人：人形机器人发布、进厂与量产计划。"],
  ["commercial", "商用车", ["商用车", "皮卡"], "卡车、客车与皮卡：新品、销量、新能源化与出海。"],
  ["two-wheelers", "两轮与摩托", ["两轮/摩托"], "两轮电动车与摩托车行业的大事。"],
  ["luxury", "豪华车", ["豪华车"], "豪华品牌的新车、价格、份额与渠道变化。"],
  ["used-cars", "二手车", ["二手车"], "二手车市场、保值率、平台与政策。"],
  ["finance", "金融与保险", ["金融/保险"], "车贷政策、新能源车险、融资租赁与相关监管。"],
  ["aftermarket", "后市场", ["后市场"], "维修保养、配件、改装与车主服务。"],
  ["price-war", "价格战", ["价格战"], "降价、限时权益、行业“反内卷”与价格监管。"],
  ["tariffs", "关税与贸易", ["关税/贸易"], "关税、反补贴调查、出口管制与本地化建厂。"],
  ["subsidy", "购置税与补贴", ["购置税/补贴"], "购置税减免、以旧换新、地方消费补贴与目录调整。"],
  ["auto-shows", "车展", ["车展"], "北京、上海、广州、成都等车展及海外车展上的发布与看点。"],
  ["safety", "安全与事故", ["安全/事故"], "碰撞测试、起火、辅助驾驶事故与安全标准。"],
];
for (const [slug, name, tags, definition] of F) topics.push({ slug, name, group: "field", tags, definition });
const N: Array<[string, string, string[], string]> = [
  ["launches", "新车上市", ["新车上市"], "正式上市并公布售价的新车与改款换代车型。"],
  ["previews", "新车预告", ["新车预告"], "亮相、申报、预售与谍照：还没上市的新车信息。"],
  ["tech-releases", "技术发布", ["技术发布"], "技术发布会、量产搭载、OTA 升级与测试认证结果。"],
  ["policy", "政策法规", ["政策/法规"], "国家与地方的汽车政策、法规、标准和监管动作。"],
  ["sales", "销量交付", ["销量/交付"], "周度、月度销量与交付数据，各类榜单与市场份额。"],
  ["pricing", "价格权益", ["价格/权益"], "官方调价、限时权益与金融政策的变化。"],
  ["marketing", "营销传播", ["营销/传播"], "发布会、广告、代言、跨界与出圈的传播事件。"],
  ["controversy", "舆情争议", ["舆情/争议"], "热搜、车主维权、高管互怼与企业回应。"],
  ["people", "人事变动", ["人事变动"], "车企与供应链公司的高管任免、离职与组织调整。"],
  ["earnings", "财报业绩", ["财报/业绩"], "季度与年度财报、盈利预告与经营指标。"],
  ["deals", "投融资并购", ["投融资/并购"], "融资、上市、收购、重组与破产。"],
  ["partnerships", "合作供应", ["合作/供应"], "战略合作、合资、供应商定点与供应关系变化。"],
  ["recalls", "召回质量", ["召回/质量"], "召回公告、质量事故、缺陷调查与处理结果。"],
  ["overseas", "出海海外", ["出海/海外"], "中国品牌出海与海外市场：出口、建厂、海外销量与当地政策。"],
  ["dealers", "渠道经销商", ["渠道/经销商"], "经销商集团、门店网络、直营与代理模式的变化。"],
  ["opinions", "观点访谈", ["观点/访谈"], "行业关键人物的访谈、演讲与判断。"],
  ["reviews", "评测体验", ["评测/体验"], "有数据的评测、对比和长期使用报告。"],
];
for (const [slug, name, tags, definition] of N) topics.push({ slug, name, group: "genre", tags, definition });
const slugs = new Set<string>();
for (const t of topics) { if (slugs.has(t.slug)) throw new Error(`dup slug ${t.slug}`); slugs.add(t.slug); }
writeFileSync(process.argv[2] + "/industry/topics.json", JSON.stringify({ groups, topics }, null, 2) + "\n");
console.log(topics.length, "topics");
