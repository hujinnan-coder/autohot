// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。汽车站的五个类别都按事件分，没有评论类。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * feedLabel 是分类 RSS 标题里的名字（不写就用 label）。公开接口、RSS 和 MCP 里要把一类并进另一类发布，写在站点设置里（site/site.ts 的 PUBLIC_CATEGORIES）。
 */
export const CATEGORIES = [
  { key: "new-car", tagColor: "indigo", label: "新车", feedLabel: "新车", section: "新车上市", guide: "具体车型的亮相、申报、预售、上市、改款换代，以及随之公布的配置、售价和交付时间。重心是这款车本身；新车带来的技术只是卖点时仍归新车，已上市车型后来的调价和权益归市场。" },
  { key: "tech", tagColor: "turquoise", label: "技术", feedLabel: "汽车技术", section: "技术与供应链", guide: "智能驾驶、智能座舱、三电与电池、芯片、平台架构、制造工艺等技术的发布、量产搭载、OTA 升级、测试与认证结果，以及供应链公司的技术与产品进展。重心是技术本身；随新车一起发布且重心在车的归新车。" },
  { key: "industry", tagColor: "orange", label: "行业", feedLabel: "行业政策", section: "政策与监管", guide: "作用于全行业或一大类企业的事：政策、法规、标准、补贴与税收、关税与贸易、监管部门的通报与约谈、行业协会的倡议与口径、充换电等基础设施、行业整体走势。只涉及一家企业的处罚、诉讼和事故归企业。" },
  { key: "company", tagColor: "violet", label: "企业", feedLabel: "企业动态", section: "企业与人物", guide: "一家或几家具体企业自身的事：人事变动、财报与业绩、融资并购与重组、战略合作、建厂与停产、诉讼与处罚、召回与质量事故、高管言论与舆情争议、经销商集团的经营变化。新闻由当事人发帖、带有态度，仍按这件事归类。" },
  { key: "market", tagColor: "green", label: "市场", feedLabel: "市场动态", section: "市场与销量", guide: "销量、交付与上险数据及榜单，已上市车型的调价、限时权益与金融政策，营销活动与传播事件，渠道与门店，出海与海外市场表现，二手车、汽车金融与保险、后市场。行业协会发布的月度销量归市场；据此出台的政策归行业。" },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（汽车行业是新车上市）：日报报头的“N 款新车”、改分类后修订已出的报告都按它数。
 * category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = { category: "new-car", tag: "新车上市", unit: "款新车" };

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["suv", "mpv", "ev", "nev", "phev", "bev", "ota", "ceo", "cfo", "ipo", "ai", "app", "4s", "l2", "l3", "l4", "noa", "ncap"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["new_car", "tech_release", "policy_regulation", "company_event", "market_data", "marketing_buzz", "opinion_analysis"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "新车上市", "新车预告", "技术发布", "政策/法规", "销量/交付", "价格/权益", "营销/传播", "舆情/争议", "人事变动", "财报/业绩",
  "投融资/并购", "合作/供应", "召回/质量", "出海/海外", "渠道/经销商", "观点/访谈", "评测/体验",
  "非汽车", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "纯电", "插混/增程", "燃油车", "智能驾驶", "智能座舱", "动力电池", "固态电池", "汽车芯片", "充电/换电", "Robotaxi", "飞行汽车", "具身智能",
  "商用车", "皮卡", "两轮/摩托", "豪华车", "二手车", "金融/保险", "后市场", "价格战", "关税/贸易", "购置税/补贴", "车展", "安全/事故",
] as const;

/** 可选的实体标签（卡片上能点进品牌页的那些）。其余品牌和公司只按主体归类，不出标签。 */
export const ENTITY_TAGS = [
  "比亚迪", "特斯拉", "吉利", "奇瑞", "长城", "长安", "上汽", "广汽", "一汽", "东风", "华为", "小米", "理想", "蔚来", "小鹏", "零跑",
  "大众", "丰田", "本田", "宝马", "奔驰", "奥迪", "宁德时代",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  新车: "新车上市", 上市: "新车上市", 新车发布: "新车上市", 改款: "新车上市", 换代: "新车上市",
  预售: "新车预告", 亮相: "新车预告", 首发: "新车预告", 谍照: "新车预告", 申报: "新车预告", 预告: "新车预告",
  技术: "技术发布", OTA: "技术发布", ota: "技术发布", 技术进展: "技术发布",
  政策: "政策/法规", 法规: "政策/法规", 监管: "政策/法规", 标准: "政策/法规", "政策/监管": "政策/法规",
  销量: "销量/交付", 交付: "销量/交付", 交付量: "销量/交付", 上险量: "销量/交付", 榜单: "销量/交付",
  价格: "价格/权益", 降价: "价格/权益", 调价: "价格/权益", 官降: "价格/权益", 权益: "价格/权益", 优惠: "价格/权益",
  营销: "营销/传播", 传播: "营销/传播", 发布会: "营销/传播", 广告: "营销/传播", 代言: "营销/传播",
  舆情: "舆情/争议", 争议: "舆情/争议", 维权: "舆情/争议", 热搜: "舆情/争议", 回应: "舆情/争议",
  人事: "人事变动", 高管变动: "人事变动", 任命: "人事变动", 离职: "人事变动",
  财报: "财报/业绩", 业绩: "财报/业绩", 营收: "财报/业绩",
  融资: "投融资/并购", 投资: "投融资/并购", 收购: "投融资/并购", 并购: "投融资/并购", 重组: "投融资/并购", 上市公司: "投融资/并购", IPO: "投融资/并购", ipo: "投融资/并购",
  合作: "合作/供应", 供应链: "合作/供应", 定点: "合作/供应", 战略合作: "合作/供应",
  召回: "召回/质量", 质量: "召回/质量", 事故: "召回/质量", 起火: "召回/质量", 自燃: "召回/质量",
  出海: "出海/海外", 海外: "出海/海外", 出口: "出海/海外",
  渠道: "渠道/经销商", 经销商: "渠道/经销商", 门店: "渠道/经销商",
  观点: "观点/访谈", 访谈: "观点/访谈", 专访: "观点/访谈", 评论: "观点/访谈",
  评测: "评测/体验", 试驾: "评测/体验", 体验: "评测/体验", 测评: "评测/体验",
  电动车: "纯电", 纯电动: "纯电", BEV: "纯电", 插混: "插混/增程", 增程: "插混/增程", PHEV: "插混/增程", 燃油: "燃油车",
  智驾: "智能驾驶", 自动驾驶: "智能驾驶", 辅助驾驶: "智能驾驶", 座舱: "智能座舱", 电池: "动力电池", 芯片: "汽车芯片",
  充电: "充电/换电", 换电: "充电/换电", 无人驾驶出租车: "Robotaxi", 低空经济: "飞行汽车", 机器人: "具身智能", 人形机器人: "具身智能",
  卡车: "商用车", 客车: "商用车", 重卡: "商用车", 摩托车: "两轮/摩托", 两轮车: "两轮/摩托", 电动两轮: "两轮/摩托",
  豪华: "豪华车", 金融: "金融/保险", 保险: "金融/保险", 关税: "关税/贸易", 贸易: "关税/贸易", 购置税: "购置税/补贴", 补贴: "购置税/补贴",
  以旧换新: "购置税/补贴", 安全: "安全/事故", 非汽车行业: "非汽车", 无关: "非汽车",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 品牌与公司：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * 以具体品牌为一条：极氪、腾势、问界各是各的；集团页在 topics.json 里用旗下品牌的 entity 标签汇总。
 * 集团自身的事（集团高管、集团财报）记在集团的主品牌上（吉利控股记在 geely，上汽集团记在 saic）。
 * aliases 给结构抽取模型看（前三个会写进提示词）；orgNames 是这家公司发消息时开头用的组织名；
 * otherNames 是其他称呼（官方账号名、子品牌、车系）。一个名字只能属于一家：重复的名字认不出主体。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  // 比亚迪
  byd: { name: "比亚迪", displayTag: "比亚迪", aliases: ["比亚迪", "BYD", "王朝网", "海洋网"], orgNames: ["比亚迪汽车", "比亚迪股份", "比亚迪集团"], otherNames: ["比亚迪王朝", "比亚迪海洋"] },
  denza: { name: "腾势", displayTag: null, aliases: ["腾势", "DENZA", "腾势汽车"] },
  fangchengbao: { name: "方程豹", displayTag: null, aliases: ["方程豹", "FCB", "方程豹汽车"] },
  yangwang: { name: "仰望", displayTag: null, aliases: ["仰望", "YANGWANG", "仰望汽车"] },
  // 吉利
  geely: { name: "吉利", displayTag: "吉利", aliases: ["吉利", "Geely", "吉利银河", "吉利控股", "吉利汽车"], orgNames: ["吉利汽车集团", "吉利控股集团", "浙江吉利控股集团"], otherNames: ["银河", "吉利中国星"] },
  lynkco: { name: "领克", displayTag: null, aliases: ["领克", "Lynk & Co", "领克汽车"] },
  zeekr: { name: "极氪", displayTag: null, aliases: ["极氪", "ZEEKR", "极氪汽车", "极氪科技"] },
  volvo: { name: "沃尔沃", displayTag: null, aliases: ["沃尔沃", "Volvo", "沃尔沃汽车", "Volvo Cars"] },
  polestar: { name: "极星", displayTag: null, aliases: ["极星", "Polestar", "Polestar极星"] },
  lotus: { name: "路特斯", displayTag: null, aliases: ["路特斯", "Lotus", "莲花跑车"] },
  smart: { name: "smart", displayTag: null, aliases: ["smart", "smart 汽车", "smart 精灵"] },
  radar: { name: "雷达", displayTag: null, aliases: ["吉利雷达", "雷达汽车", "RADAR 皮卡"] },
  farizon: { name: "远程", displayTag: null, aliases: ["远程新能源商用车", "吉利远程", "Farizon"] },
  // 奇瑞
  chery: { name: "奇瑞", displayTag: "奇瑞", aliases: ["奇瑞", "Chery", "奇瑞汽车", "奇瑞控股"], orgNames: ["奇瑞汽车股份", "奇瑞控股集团", "奇瑞集团"], otherNames: ["奇瑞风云"] },
  exeed: { name: "星途", displayTag: null, aliases: ["星途", "EXEED", "星纪元"] },
  jetour: { name: "捷途", displayTag: null, aliases: ["捷途", "JETOUR", "捷途汽车", "捷途山海"] },
  icar: { name: "iCAR", displayTag: null, aliases: ["iCAR", "奇瑞 iCAR", "iCAUR"] },
  omoda: { name: "欧萌达 / 捷酷", displayTag: null, aliases: ["欧萌达", "OMODA", "JAECOO", "捷酷"] },
  // 长城
  gwm: { name: "长城", displayTag: "长城", aliases: ["长城汽车", "GWM", "长城炮", "Great Wall Motor"], orgNames: ["长城汽车股份"], otherNames: ["长城皮卡"] },
  haval: { name: "哈弗", displayTag: null, aliases: ["哈弗", "HAVAL", "哈弗汽车"] },
  wey: { name: "魏牌", displayTag: null, aliases: ["魏牌", "WEY", "魏牌新能源"] },
  tank: { name: "坦克", displayTag: null, aliases: ["坦克品牌", "坦克 SUV", "TANK"] },
  ora: { name: "欧拉", displayTag: null, aliases: ["欧拉", "ORA", "欧拉汽车"] },
  // 长安
  changan: { name: "长安", displayTag: "长安", aliases: ["长安汽车", "Changan", "长安启源", "中国长安汽车集团"], orgNames: ["重庆长安汽车", "长安汽车集团"], otherNames: ["启源", "长安引力", "长安凯程"] },
  deepal: { name: "深蓝", displayTag: null, aliases: ["深蓝汽车", "Deepal", "长安深蓝"] },
  avatr: { name: "阿维塔", displayTag: null, aliases: ["阿维塔", "AVATR", "阿维塔科技"] },
  // 上汽
  saic: { name: "上汽", displayTag: "上汽", aliases: ["上汽集团", "SAIC", "上汽乘用车", "上海汽车集团"], orgNames: ["上海汽车集团股份"] },
  roewe: { name: "荣威", displayTag: null, aliases: ["荣威", "Roewe", "上汽荣威"] },
  mg: { name: "MG 名爵", displayTag: null, aliases: ["名爵", "MG 名爵", "上汽名爵", "MG Motor"] },
  im: { name: "智己", displayTag: null, aliases: ["智己", "IM Motors", "智己汽车"] },
  maxus: { name: "上汽大通", displayTag: null, aliases: ["上汽大通", "MAXUS", "大通汽车"] },
  wuling: { name: "五菱", displayTag: null, aliases: ["五菱", "上汽通用五菱", "Wuling", "五菱汽车"] },
  baojun: { name: "宝骏", displayTag: null, aliases: ["宝骏", "Baojun", "宝骏汽车"] },
  shangjie: { name: "尚界", displayTag: null, aliases: ["尚界", "SAIC 尚界", "鸿蒙智行尚界"] },
  // 广汽
  gac: { name: "广汽", displayTag: "广汽", aliases: ["广汽集团", "GAC", "广汽传祺", "广州汽车集团"], orgNames: ["广州汽车集团股份"], otherNames: ["传祺", "Trumpchi"] },
  aion: { name: "埃安", displayTag: null, aliases: ["埃安", "AION", "广汽埃安"] },
  hyptec: { name: "昊铂", displayTag: null, aliases: ["昊铂", "Hyptec", "广汽昊铂"] },
  // 一汽
  faw: { name: "一汽", displayTag: "一汽", aliases: ["中国一汽", "FAW", "一汽集团", "第一汽车集团"], orgNames: ["中国第一汽车集团"] },
  hongqi: { name: "红旗", displayTag: null, aliases: ["红旗品牌", "一汽红旗", "Hongqi", "红旗汽车"] },
  bestune: { name: "奔腾", displayTag: null, aliases: ["一汽奔腾", "奔腾汽车", "Bestune"] },
  jiefang: { name: "解放", displayTag: null, aliases: ["一汽解放", "解放卡车", "FAW Jiefang"] },
  // 东风
  dongfeng: { name: "东风", displayTag: "东风", aliases: ["东风汽车", "Dongfeng", "东风集团", "东风公司"], orgNames: ["东风汽车集团"], otherNames: ["东风风神", "东风奕派", "东风纳米", "东风风行", "奕派科技"] },
  voyah: { name: "岚图", displayTag: null, aliases: ["岚图", "VOYAH", "岚图汽车"] },
  mengshi: { name: "猛士", displayTag: null, aliases: ["东风猛士", "猛士科技", "猛士 917"] },
  // 北汽
  baic: { name: "北汽", displayTag: null, aliases: ["北汽集团", "BAIC", "北京汽车", "北汽新能源"], orgNames: ["北京汽车集团"], otherNames: ["北京越野", "北汽蓝谷"] },
  arcfox: { name: "极狐", displayTag: null, aliases: ["极狐", "ARCFOX", "ARCFOX极狐", "极狐汽车"] },
  xiangjie: { name: "享界", displayTag: null, aliases: ["享界", "STELATO", "鸿蒙智行享界"] },
  foton: { name: "福田", displayTag: null, aliases: ["福田汽车", "北汽福田", "Foton"] },
  // 华为系与赛力斯、江淮
  huawei: { name: "华为", displayTag: "华为", aliases: ["华为", "Huawei", "鸿蒙智行", "华为乾崑", "引望"], orgNames: ["华为技术", "华为终端", "华为智能汽车解决方案 BU"], otherNames: ["HIMA", "乾崑智驾", "鸿蒙座舱"] },
  aito: { name: "问界", displayTag: null, aliases: ["问界", "AITO", "AITO 问界", "鸿蒙智行问界"] },
  seres: { name: "赛力斯", displayTag: null, aliases: ["赛力斯", "SERES", "SERES赛力斯", "赛力斯集团", "赛力斯汽车"] },
  luxeed: { name: "智界", displayTag: null, aliases: ["智界", "LUXEED", "鸿蒙智行智界"] },
  maextro: { name: "尊界", displayTag: null, aliases: ["尊界", "MAEXTRO", "鸿蒙智行尊界"] },
  jac: { name: "江淮", displayTag: null, aliases: ["江淮汽车", "JAC", "江汽集团"] },
  // 新势力
  nio: { name: "蔚来", displayTag: "蔚来", aliases: ["蔚来", "NIO", "乐道", "蔚来汽车"], orgNames: ["蔚来公司", "蔚来集团"], otherNames: ["ONVO", "firefly", "萤火虫", "蔚来能源"] },
  xpeng: { name: "小鹏", displayTag: "小鹏", aliases: ["小鹏", "XPENG", "小鹏汽车", "小鹏汇天"], orgNames: ["小鹏汽车公司"], otherNames: ["XPeng", "小鹏 MONA", "汇天"] },
  "li-auto": { name: "理想", displayTag: "理想", aliases: ["理想汽车", "Li Auto", "理想 L 系列", "理想 MEGA"], orgNames: ["理想汽车公司"], otherNames: ["理想同学", "理想超充"] },
  leapmotor: { name: "零跑", displayTag: "零跑", aliases: ["零跑", "Leapmotor", "零跑汽车", "零跑科技"] },
  xiaomi: { name: "小米汽车", displayTag: "小米", aliases: ["小米汽车", "Xiaomi EV", "小米 SU7", "小米 YU7", "小米集团"], orgNames: ["小米公司", "小米科技"], otherNames: ["小米", "Xiaomi"] },
  neta: { name: "哪吒", displayTag: null, aliases: ["哪吒汽车", "NETA", "合众新能源"] },
  jiyue: { name: "极越", displayTag: null, aliases: ["极越", "JIYUE", "集度"] },
  // 其他自主与商用车
  jmc: { name: "江铃", displayTag: null, aliases: ["江铃汽车", "JMC", "江铃集团"] },
  sinotruk: { name: "中国重汽", displayTag: null, aliases: ["中国重汽", "Sinotruk", "重汽集团"] },
  shacman: { name: "陕汽", displayTag: null, aliases: ["陕汽", "陕汽重卡", "Shacman"] },
  yutong: { name: "宇通", displayTag: null, aliases: ["宇通客车", "宇通集团", "Yutong"] },
  "skyworth-auto": { name: "创维汽车", displayTag: null, aliases: ["创维汽车", "Skyworth", "创维汽车集团"] },
  "livan": { name: "睿蓝", displayTag: null, aliases: ["睿蓝", "Livan", "吉利睿蓝", "睿蓝汽车"] },
  "haima": { name: "海马", displayTag: null, aliases: ["海马汽车", "海马", "Haima"] },
  "qoros": { name: "观致", displayTag: null, aliases: ["观致", "Qoros", "观致汽车"] },
  "hycan": { name: "合创", displayTag: null, aliases: ["合创", "Hycan", "合创汽车", "广汽合创"] },
  "hiphi": { name: "高合", displayTag: null, aliases: ["高合", "HiPhi", "高合汽车", "华人运通"] },
  "hengchi": { name: "恒驰", displayTag: null, aliases: ["恒驰", "恒驰汽车", "Hengchi"] },
  "landian": { name: "蓝电", displayTag: null, aliases: ["蓝电", "赛力斯蓝电", "蓝电汽车"] },
  "sol": { name: "思皓", displayTag: null, aliases: ["思皓", "SOL", "大众思皓", "江淮大众"] },
  // 德系
  volkswagen: { name: "大众", displayTag: "大众", aliases: ["大众汽车", "Volkswagen", "上汽大众", "一汽-大众", "大众安徽", "捷达"], orgNames: ["大众汽车集团", "大众汽车集团（中国）"], otherNames: ["VW", "一汽大众", "大众中国", "ID. 系列"] },
  audi: { name: "奥迪", displayTag: "奥迪", aliases: ["奥迪", "Audi", "一汽奥迪", "上汽奥迪", "AUDI"] },
  porsche: { name: "保时捷", displayTag: null, aliases: ["保时捷", "Porsche", "保时捷中国"] },
  bmw: { name: "宝马", displayTag: "宝马", aliases: ["宝马", "BMW", "华晨宝马", "宝马集团"], otherNames: ["宝马中国", "BMW Group"] },
  mini: { name: "MINI", displayTag: null, aliases: ["MINI 品牌", "宝马 MINI", "MINI Cooper"] },
  mercedes: { name: "奔驰", displayTag: "奔驰", aliases: ["奔驰", "梅赛德斯-奔驰", "Mercedes-Benz", "北京奔驰"], otherNames: ["Mercedes", "梅赛德斯", "奔驰中国", "AMG", "迈巴赫"] },
  "skoda": { name: "斯柯达", displayTag: null, aliases: ["斯柯达", "SKODA", "斯柯达汽车", "上汽斯柯达"] },
  // 日系
  toyota: { name: "丰田", displayTag: "丰田", aliases: ["丰田", "Toyota", "一汽丰田", "广汽丰田"], orgNames: ["丰田汽车公司", "丰田汽车"], otherNames: ["丰田中国", "bZ 系列"] },
  lexus: { name: "雷克萨斯", displayTag: null, aliases: ["雷克萨斯", "Lexus", "凌志"] },
  honda: { name: "本田", displayTag: "本田", aliases: ["本田", "Honda", "广汽本田", "东风本田"], otherNames: ["本田中国", "讴歌", "Acura"] },
  nissan: { name: "日产", displayTag: null, aliases: ["日产", "Nissan", "东风日产", "郑州日产"], otherNames: ["英菲尼迪", "Infiniti", "启辰"] },
  mazda: { name: "马自达", displayTag: null, aliases: ["马自达", "Mazda", "长安马自达"] },
  subaru: { name: "斯巴鲁", displayTag: null, aliases: ["斯巴鲁", "Subaru"] },
  "mitsubishi": { name: "三菱", displayTag: null, aliases: ["三菱汽车", "三菱", "Mitsubishi", "Mitsubishi Motors", "广汽三菱"] },
  "suzuki": { name: "铃木", displayTag: null, aliases: ["铃木", "SUZUKI", "铃木汽车", "长安铃木"] },
  // 韩系
  hyundai: { name: "现代", displayTag: null, aliases: ["现代汽车", "Hyundai", "北京现代", "现代汽车集团"], otherNames: ["捷尼赛思", "Genesis"] },
  kia: { name: "起亚", displayTag: null, aliases: ["起亚", "Kia", "悦达起亚"] },
  // 美系
  tesla: { name: "特斯拉", displayTag: "特斯拉", aliases: ["特斯拉", "Tesla", "特斯拉中国"], otherNames: ["Model Y", "Model 3", "Cybertruck", "FSD", "特斯拉上海超级工厂"] },
  gm: { name: "通用汽车", displayTag: null, aliases: ["通用汽车", "General Motors", "上汽通用", "GM"], otherNames: ["通用中国", "道朗格"] },
  buick: { name: "别克", displayTag: null, aliases: ["别克", "Buick", "上汽通用别克"] },
  chevrolet: { name: "雪佛兰", displayTag: null, aliases: ["雪佛兰", "Chevrolet", "上汽通用雪佛兰"] },
  cadillac: { name: "凯迪拉克", displayTag: null, aliases: ["凯迪拉克", "Cadillac", "上汽通用凯迪拉克"] },
  ford: { name: "福特", displayTag: null, aliases: ["福特", "Ford", "长安福特", "江铃福特"], otherNames: ["福特中国", "Ford Motor"] },
  lincoln: { name: "林肯", displayTag: null, aliases: ["林肯", "Lincoln", "林肯中国"] },
  "chrysler": { name: "克莱斯勒", displayTag: null, aliases: ["克莱斯勒", "Chrysler", "克莱斯勒集团"] },
  "dodge": { name: "道奇", displayTag: null, aliases: ["道奇", "Dodge", "道奇公羊", "RAM"] },
  // 欧系其他
  stellantis: { name: "Stellantis", displayTag: null, aliases: ["Stellantis", "斯特兰蒂斯", "神龙汽车"], otherNames: ["标致", "雪铁龙", "Jeep", "Peugeot", "Citroën", "东风标致", "东风雪铁龙"] },
  renault: { name: "雷诺", displayTag: null, aliases: ["雷诺", "Renault", "雷诺集团"] },
  jlr: { name: "捷豹路虎", displayTag: null, aliases: ["捷豹路虎", "JLR", "路虎", "捷豹", "奇瑞捷豹路虎"], otherNames: ["Land Rover", "Jaguar", "揽胜"] },
  ferrari: { name: "法拉利", displayTag: null, aliases: ["法拉利", "Ferrari"] },
  lamborghini: { name: "兰博基尼", displayTag: null, aliases: ["兰博基尼", "Lamborghini"] },
  bentley: { name: "宾利", displayTag: null, aliases: ["宾利", "Bentley"] },
  "rolls-royce": { name: "劳斯莱斯", displayTag: null, aliases: ["劳斯莱斯", "Rolls-Royce"] },
  maserati: { name: "玛莎拉蒂", displayTag: null, aliases: ["玛莎拉蒂", "Maserati"] },
  "mclaren": { name: "迈凯伦", displayTag: null, aliases: ["迈凯伦", "McLaren", "迈凯伦汽车"] },
  "bugatti": { name: "布加迪", displayTag: null, aliases: ["布加迪", "Bugatti"] },
  "alfa-romeo": { name: "阿尔法·罗密欧", displayTag: null, aliases: ["阿尔法·罗密欧", "阿尔法罗密欧", "Alfa Romeo"] },
  "aston-martin": { name: "阿斯顿·马丁", displayTag: null, aliases: ["阿斯顿·马丁", "阿斯顿马丁", "Aston Martin"] },
  "opel": { name: "欧宝", displayTag: null, aliases: ["欧宝", "Opel"] },
  // 动力电池
  catl: { name: "宁德时代", displayTag: "宁德时代", aliases: ["宁德时代", "CATL", "宁王"], orgNames: ["宁德时代新能源科技"], otherNames: ["麒麟电池", "神行电池", "巧克力换电"] },
  fudi: { name: "弗迪", displayTag: null, aliases: ["弗迪电池", "弗迪科技", "FinDreams"] },
  calb: { name: "中创新航", displayTag: null, aliases: ["中创新航", "CALB"] },
  gotion: { name: "国轩高科", displayTag: null, aliases: ["国轩高科", "Gotion"] },
  eve: { name: "亿纬锂能", displayTag: null, aliases: ["亿纬锂能", "EVE Energy"] },
  sunwoda: { name: "欣旺达", displayTag: null, aliases: ["欣旺达", "Sunwoda"] },
  svolt: { name: "蜂巢能源", displayTag: null, aliases: ["蜂巢能源", "SVOLT"] },
  "lg-energy": { name: "LG 新能源", displayTag: null, aliases: ["LG 新能源", "LG Energy Solution", "LGES"] },
  // 智驾、芯片与软件
  momenta: { name: "Momenta", displayTag: null, aliases: ["Momenta", "魔门塔"] },
  horizon: { name: "地平线", displayTag: null, aliases: ["地平线", "Horizon Robotics", "地平线机器人"] },
  "black-sesame": { name: "黑芝麻智能", displayTag: null, aliases: ["黑芝麻智能", "Black Sesame"] },
  zhuoyu: { name: "卓驭", displayTag: null, aliases: ["卓驭", "卓驭科技", "大疆车载"] },
  deeproute: { name: "元戎启行", displayTag: null, aliases: ["元戎启行", "DeepRoute"] },
  qcraft: { name: "轻舟智航", displayTag: null, aliases: ["轻舟智航", "QCraft"] },
  hesai: { name: "禾赛", displayTag: null, aliases: ["禾赛科技", "Hesai", "禾赛"] },
  robosense: { name: "速腾聚创", displayTag: null, aliases: ["速腾聚创", "RoboSense"] },
  nvidia: { name: "英伟达", displayTag: null, aliases: ["英伟达", "NVIDIA", "NVIDIA DRIVE"] },
  qualcomm: { name: "高通", displayTag: null, aliases: ["高通", "Qualcomm", "骁龙座舱"] },
  mobileye: { name: "Mobileye", displayTag: null, aliases: ["Mobileye"] },
  "desay-sv": { name: "德赛西威", displayTag: null, aliases: ["德赛西威", "Desay SV"] },
  ecarx: { name: "亿咖通", displayTag: null, aliases: ["亿咖通", "ECARX"] },
  thundersoft: { name: "中科创达", displayTag: null, aliases: ["中科创达", "ThunderSoft"] },
  // Robotaxi 与出行
  apollo: { name: "百度 Apollo", displayTag: null, aliases: ["萝卜快跑", "百度 Apollo", "Apollo Go", "百度智驾"] },
  pony: { name: "小马智行", displayTag: null, aliases: ["小马智行", "Pony.ai"] },
  weride: { name: "文远知行", displayTag: null, aliases: ["文远知行", "WeRide"] },
  waymo: { name: "Waymo", displayTag: null, aliases: ["Waymo"] },
  didi: { name: "滴滴", displayTag: null, aliases: ["滴滴", "滴滴出行", "DiDi"] },
  ehang: { name: "亿航", displayTag: null, aliases: ["亿航智能", "EHang"] },
  // 零部件
  bosch: { name: "博世", displayTag: null, aliases: ["博世", "Bosch", "博世中国"] },
  continental: { name: "大陆集团", displayTag: null, aliases: ["大陆集团", "Continental AG", "德国大陆"] },
  zf: { name: "采埃孚", displayTag: null, aliases: ["采埃孚", "ZF"] },
  denso: { name: "电装", displayTag: null, aliases: ["电装", "Denso"] },
  magna: { name: "麦格纳", displayTag: null, aliases: ["麦格纳", "Magna"] },
  fuyao: { name: "福耀玻璃", displayTag: null, aliases: ["福耀玻璃", "福耀集团", "Fuyao"] },
  joyson: { name: "均胜电子", displayTag: null, aliases: ["均胜电子", "Joyson"] },
  tuopu: { name: "拓普集团", displayTag: null, aliases: ["拓普集团", "Tuopu"] },
  // 渠道、平台与充电
  zhongsheng: { name: "中升集团", displayTag: null, aliases: ["中升集团", "中升控股", "Zhongsheng"] },
  yongda: { name: "永达汽车", displayTag: null, aliases: ["永达汽车", "永达集团"] },
  guanghui: { name: "广汇汽车", displayTag: null, aliases: ["广汇汽车", "广汇汽车服务"] },
  autohome: { name: "汽车之家", displayTag: null, aliases: ["汽车之家", "Autohome"] },
  dongchedi: { name: "懂车帝", displayTag: null, aliases: ["懂车帝", "Dongchedi"] },
  yiche: { name: "易车", displayTag: null, aliases: ["易车", "Yiche", "易车网"] },
  guazi: { name: "瓜子二手车", displayTag: null, aliases: ["瓜子二手车", "车好多"] },
  teld: { name: "特来电", displayTag: null, aliases: ["特来电", "特锐德"] },
  "star-charge": { name: "星星充电", displayTag: null, aliases: ["星星充电", "万帮数字能源"] },
  // 行业机构
  cpca: { name: "乘联会", displayTag: null, aliases: ["乘联会", "乘联分会", "乘用车市场信息联席会", "CPCA"] },
  caam: { name: "中汽协", displayTag: null, aliases: ["中汽协", "中国汽车工业协会", "CAAM"] },
  cada: { name: "中国汽车流通协会", displayTag: null, aliases: ["中国汽车流通协会", "流通协会", "CADA"] },
  catarc: { name: "中汽中心", displayTag: null, aliases: ["中汽中心", "中国汽车技术研究中心", "CATARC", "C-NCAP"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 只列写法不会和日常用词混淆的品牌；“理想”“大众”“现代”“长城”这类词要带上“汽车”或车型才算。
 * 每条的写法同时覆盖中文名和外文名，外文稿件写成中文摘要后才对得上。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "byd", name: "比亚迪", patterns: [/比亚迪|\bBYD\b/i] },
  { id: "denza", name: "腾势", patterns: [/腾势|\bdenza\b/i] },
  { id: "fangchengbao", name: "方程豹", patterns: [/方程豹|fang\s?cheng\s?bao/i] },
  { id: "yangwang", name: "仰望", patterns: [/仰望(?:汽车|U[789]|品牌)|\byangwang\b/i] },
  { id: "tesla", name: "特斯拉", patterns: [/特斯拉|\btesla\b/i] },
  { id: "geely", name: "吉利", patterns: [/吉利|\bgeely\b/i] },
  { id: "zeekr", name: "极氪", patterns: [/极氪|\bzeekr\b/i] },
  { id: "lynkco", name: "领克", patterns: [/领克|lynk\s?&?\s?co/i] },
  { id: "volvo", name: "沃尔沃", patterns: [/沃尔沃|\bvolvo\b/i] },
  { id: "chery", name: "奇瑞", patterns: [/奇瑞|\bchery\b/i] },
  { id: "gwm", name: "长城汽车", patterns: [/长城汽车|长城炮|\bGWM\b|great\s+wall\s+motor/i] },
  { id: "haval", name: "哈弗", patterns: [/哈弗|\bhaval\b/i] },
  { id: "changan", name: "长安", patterns: [/长安汽车|长安启源|长安福特|长安马自达|\bchangan\b/i] },
  { id: "avatr", name: "阿维塔", patterns: [/阿维塔|\bavatr\b/i] },
  { id: "saic", name: "上汽", patterns: [/上汽|\bSAIC\b/i] },
  { id: "gac", name: "广汽", patterns: [/广汽|\bGAC\b/] },
  { id: "aion", name: "埃安", patterns: [/埃安|\baion\b/i] },
  { id: "faw", name: "一汽", patterns: [/一汽|\bFAW\b/] },
  { id: "dongfeng", name: "东风", patterns: [/东风(?:汽车|集团|公司|日产|本田|风神|奕派|纳米|风行|猛士|标致|雪铁龙)|\bdongfeng\b/i] },
  { id: "voyah", name: "岚图", patterns: [/岚图|\bvoyah\b/i] },
  { id: "baic", name: "北汽", patterns: [/北汽|北京汽车|\bBAIC\b/] },
  { id: "huawei", name: "华为", patterns: [/华为|鸿蒙智行|乾崑|\bhuawei\b/i] },
  { id: "aito", name: "问界", patterns: [/问界|\bAITO\b/] },
  { id: "seres", name: "赛力斯", patterns: [/赛力斯|\bseres\b/i] },
  { id: "nio", name: "蔚来", patterns: [/蔚来|\bNIO\b|乐道|\bonvo\b/i] },
  { id: "xpeng", name: "小鹏", patterns: [/小鹏|\bxpeng\b/i] },
  { id: "li-auto", name: "理想汽车", patterns: [/理想汽车|理想\s?(?:L[6-9]|i[6-9]|MEGA|ONE|同学|超充)|\bli\s+auto\b/i] },
  { id: "leapmotor", name: "零跑", patterns: [/零跑|\bleapmotor\b/i] },
  { id: "xiaomi", name: "小米", patterns: [/小米|\bxiaomi\b/i] },
  { id: "neta", name: "哪吒汽车", patterns: [/哪吒汽车|合众新能源|\bneta\s+auto\b/i] },
  { id: "volkswagen", name: "大众汽车", patterns: [/大众汽车|上汽大众|一汽[-‐]?大众|大众安徽|大众(?:集团|品牌|中国|ID\.)|\bvolkswagen\b|\bVW\b/i] },
  { id: "audi", name: "奥迪", patterns: [/奥迪|\baudi\b/i] },
  { id: "porsche", name: "保时捷", patterns: [/保时捷|\bporsche\b/i] },
  { id: "bmw", name: "宝马", patterns: [/宝马|\bBMW\b/i] },
  { id: "mercedes", name: "奔驰", patterns: [/奔驰|梅赛德斯|\bmercedes\b/i] },
  { id: "toyota", name: "丰田", patterns: [/丰田|\btoyota\b/i] },
  { id: "lexus", name: "雷克萨斯", patterns: [/雷克萨斯|\blexus\b/i] },
  { id: "honda", name: "本田", patterns: [/本田|\bhonda\b/i] },
  { id: "nissan", name: "日产", patterns: [/日产|\bnissan\b/i] },
  { id: "mazda", name: "马自达", patterns: [/马自达|\bmazda\b/i] },
  { id: "hyundai", name: "现代汽车", patterns: [/现代汽车|北京现代|现代(?:集团|起亚)|\bhyundai\b/i] },
  { id: "kia", name: "起亚", patterns: [/起亚|\bkia\b/i] },
  { id: "gm", name: "通用汽车", patterns: [/通用汽车|上汽通用|general\s+motors|\bGM\b/] },
  { id: "ford", name: "福特", patterns: [/福特|\bford\b/i] },
  { id: "stellantis", name: "Stellantis", patterns: [/stellantis|斯特兰蒂斯/i] },
  { id: "jlr", name: "捷豹路虎", patterns: [/捷豹|路虎|\bJLR\b|land\s+rover|\bjaguar\b/i] },
  { id: "catl", name: "宁德时代", patterns: [/宁德时代|\bCATL\b/i] },
  { id: "bosch", name: "博世", patterns: [/博世|\bbosch\b/i] },
  { id: "momenta", name: "Momenta", patterns: [/momenta/i] },
  { id: "horizon", name: "地平线", patterns: [/地平线|horizon\s+robotics/i] },
  { id: "nvidia", name: "英伟达", patterns: [/英伟达|\bnvidia\b/i] },
  { id: "qualcomm", name: "高通", patterns: [/高通|\bqualcomm\b/i] },
  { id: "waymo", name: "Waymo", patterns: [/\bwaymo\b/i] },
  { id: "pony", name: "小马智行", patterns: [/小马智行|pony\.?ai/i] },
  { id: "weride", name: "文远知行", patterns: [/文远知行|\bweride\b/i] },
  { id: "apollo", name: "萝卜快跑", patterns: [/萝卜快跑|apollo\s+go/i] },

  { id: "skoda", name: "斯柯达", patterns: [/斯柯达|\bskoda\b/i] },
  { id: "mitsubishi", name: "三菱汽车", patterns: [/三菱(?:汽车|欧蓝德|奕歌|劲炫|帕杰罗)|mitsubishi\s+motors/i] },
  { id: "suzuki", name: "铃木", patterns: [/铃木(?:汽车|雨燕|维特拉|吉姆尼)|\bsuzuki\b/i] },
  { id: "mclaren", name: "迈凯伦", patterns: [/迈凯伦|\bmclaren\b/i] },
  { id: "bugatti", name: "布加迪", patterns: [/布加迪|\bbugatti\b/i] },
  { id: "alfa-romeo", name: "阿尔法·罗密欧", patterns: [/阿尔法[·‧\s]?罗密欧|\balfa\s+romeo\b/i] },
  { id: "aston-martin", name: "阿斯顿·马丁", patterns: [/阿斯顿[·‧\s]?马丁|\baston\s+martin\b/i] },
  { id: "chrysler", name: "克莱斯勒", patterns: [/克莱斯勒|\bchrysler\b/i] },
  { id: "dodge", name: "道奇", patterns: [/道奇(?:汽车|公羊|战斧|Charger|Challenger|Durango|Hornet)/i] },
  { id: "opel", name: "欧宝", patterns: [/欧宝|\bopel\b/i] },
  { id: "skyworth-auto", name: "创维汽车", patterns: [/创维(?:汽车|氢能)|\bskyworth\b/i] },
  { id: "livan", name: "睿蓝", patterns: [/睿蓝|\blivan\b/i] },
  { id: "haima", name: "海马汽车", patterns: [/海马(?:汽车|S5|8S|7X|爱尚|福美来)|\bhaima\b/i] },
  { id: "qoros", name: "观致", patterns: [/观致|\bqoros\b/i] },
  { id: "hycan", name: "合创汽车", patterns: [/合创(?:汽车|Z|V|A06|007)|\bhycan\b/i] },
  { id: "hiphi", name: "高合", patterns: [/高合(?:汽车)?|HiPhi|华人运通/i] },
  { id: "hengchi", name: "恒驰", patterns: [/恒驰(?:汽车|[1-5])|\bhengchi\b/i] },
  { id: "landian", name: "蓝电", patterns: [/蓝电|\blandian\b/i] },
  { id: "sol", name: "思皓", patterns: [/思皓|江淮大众|大众思皓/i] },];

/** 这些域名上的文章，发布方就是对应的公司（媒体和托管平台不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "byd", domains: ["byd.com", "bydauto.com.cn"] },
  { entityId: "tesla", domains: ["tesla.com", "tesla.cn"] },
  { entityId: "geely", domains: ["geely.com", "zgh.com"] },
  { entityId: "nio", domains: ["nio.com", "nio.cn"] },
  { entityId: "xpeng", domains: ["xiaopeng.com", "xpeng.com"] },
  { entityId: "li-auto", domains: ["lixiang.com"] },
  { entityId: "catl", domains: ["catl.com"] },
  { entityId: "volkswagen", domains: ["volkswagen-group.com", "volkswagen-newsroom.com", "vw.com.cn"] },
  { entityId: "bmw", domains: ["bmwgroup.com", "bmw.com.cn"] },
  { entityId: "mercedes", domains: ["mercedes-benz.com", "mercedes-benz.com.cn"] },
  { entityId: "toyota", domains: ["toyota.com.cn", "global.toyota"] },
  { entityId: "cpca", domains: ["cpcaauto.com"] },
  { entityId: "caam", domains: ["caam.org.cn"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "tesla", pattern: /\bTSLA\b|马斯克|\bElon\s+Musk\b/i },
  { entityId: "xiaomi", pattern: /雷军/ },
  { entityId: "nio", pattern: /李斌/ },
  { entityId: "xpeng", pattern: /何小鹏/ },
  { entityId: "li-auto", pattern: /\bLi\s+Xiang\b|\bLI\s+L[6-9]\b/ },
  { entityId: "huawei", pattern: /余承东|\bHIMA\b/ },
  { entityId: "byd", pattern: /王传福/ },
  { entityId: "geely", pattern: /李书福/ },
  { entityId: "gwm", pattern: /魏建军/ },
];
