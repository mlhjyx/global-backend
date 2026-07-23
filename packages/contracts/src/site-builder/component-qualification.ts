import { z } from "zod";
import {
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  type SiteSpecComponentType,
} from "./site-spec";

export const COMPONENT_QUALIFICATION_PARTS = [
  "schema",
  "variants",
  "contentBudget",
  "accessibility",
  "reducedMotion",
  "fixtures",
  "visualRegression",
] as const;
export type ComponentQualificationPart =
  (typeof COMPONENT_QUALIFICATION_PARTS)[number];

const evidenceRefSchema = z
  .object({ artifactId: z.string().trim().min(1).max(256) })
  .strict();

const componentQualificationSchema = z
  .object({
    schema: evidenceRefSchema,
    variants: evidenceRefSchema,
    contentBudget: evidenceRefSchema,
    accessibility: evidenceRefSchema,
    reducedMotion: evidenceRefSchema,
    fixtures: evidenceRefSchema,
    visualRegression: evidenceRefSchema,
  })
  .strict();

export type ComponentQualificationEvidence = z.infer<
  typeof componentQualificationSchema
>;

const artifactBase = {
  artifactId: z.string().trim().min(1).max(256),
  componentType: z.enum(SITE_SPEC_COMPONENT_TYPES),
  repositoryPath: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

const repositoryByteRefBase = {
  repositoryPath: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

const fixtureFileSchema = z
  .object({
    fixtureId: z.string().trim().min(1).max(128),
    ...repositoryByteRefBase,
  })
  .strict();

const visualOutputSchemas = [
  z.object({ breakpoint: z.literal(375), ...repositoryByteRefBase }).strict(),
  z.object({ breakpoint: z.literal(768), ...repositoryByteRefBase }).strict(),
  z.object({ breakpoint: z.literal(1440), ...repositoryByteRefBase }).strict(),
] satisfies [z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny];

const componentQualificationArtifactSchema = z.discriminatedUnion("part", [
  z.object({ ...artifactBase, part: z.literal("schema") }).strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("variants"),
      variantValues: z.array(z.string().trim().min(1).max(64)).min(1),
    })
    .strict(),
  z.object({ ...artifactBase, part: z.literal("contentBudget") }).strict(),
  z.object({ ...artifactBase, part: z.literal("accessibility") }).strict(),
  z.object({ ...artifactBase, part: z.literal("reducedMotion") }).strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("fixtures"),
      fixtureIds: z.array(z.string().trim().min(1).max(128)).min(1),
      fixtureFiles: z.array(fixtureFileSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("visualRegression"),
      breakpoints: z.tuple([z.literal(375), z.literal(768), z.literal(1440)]),
      outputs: z.tuple(visualOutputSchemas),
    })
    .strict(),
]);

export type ComponentQualificationArtifact = z.infer<
  typeof componentQualificationArtifactSchema
>;

/**
 * The ten R1 components predate the M1-e-A seven-part contract. They remain
 * release-eligible for backward compatibility, but must never be mistaken for
 * M1-e-A-qualified components. The frozen exception is deliberately not an
 * integrity-check input, so callers cannot extend it alongside the release list.
 */
export const SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES = Object.freeze([
  "AboutBlock",
  "CertWall",
  "CtaBanner",
  "FaqAccordion",
  "HeroBanner",
  "InquiryForm",
  "MapLocation",
  "ProcessTimeline",
  "ProductGrid",
  "StatsBand",
] as const satisfies readonly SiteSpecComponentType[]);

/**
 * Checked-in evidence artifact registry. A qualification may reference only
 * entries in this registry. CI independently hashes each repositoryPath and
 * compares it with sha256, so a non-empty id alone can never satisfy the gate.
 */
const A10_SHA256 = {
  EditorialHero: { schema:"75b90e162e752bf7c441976bd6510817cf39ed1931824445affe38404cc1f89a", variants:"da2201aea32e30d5a96ccd20401ec93100912a334330de56bbe68e5e2a98c81d", contentBudget:"52d7ce7d69e450bca2b49171a0ce86f27c836e1e86383573f8c8af3f55895fd5", accessibility:"56a98b6b8f8c2c12912ac34b19531604047f5f6136e497834d1504e89af294e1", reducedMotion:"f0206cae7aa26a2f2db94cac1b1bbf830d100f2490f0b585a4e6b96572890493", fixtures:"a64febf4de01cf31cf6e6fe2e8c15d89da7fbf99c02da886d98bcdcda350aa19", visualRegression:"181ea2caefb0cbaa25aca7f9c2e3e5509b0b1bb3b464f5253a70a1692c172492", fixture:"317affd5b037dda4d5364c6afe069d9a1e58a9b67de16ad8504186b44458f5a6", mobile:"6a2c6b74946e42e74119204f10b0060e3f443d084ece0f33921f29b18c5b4f6b", tablet:"f1d7bffab81b5f138aa36a52fff602a3c76f297847261d7bef33b9a4e6cba5e6", desktop:"0801efb5e3d6d5089a48014167122a86c4f4c0f0747e80c53099db998eb27475" },
  SplitAbout: { schema:"a958b4368f5fe9335bc08eee1db0ccbce095b405c3d6a43c23cc63cf62e5c0b1", variants:"591853f161c0fb6d93388d69d9bffbed5556abc1cc2b4bbf7275d6de75c96d81", contentBudget:"0ab3da56d61165c2c6821cb962b5b52e7e0a8d353b26580c08937042fb9417e1", accessibility:"1a43e032f4abf61cb3e520cbe235acfc00a95d40a2606fea52e6b7757db764f4", reducedMotion:"9eb95e8d3c30ba2817529c79101d45c825ed886ec05ca87f9ee1fd7b6bdfbd99", fixtures:"36c7d104217cc8605bb0b068a08c53b9dcf3002650e62d9b2ee6ff0ec5e9adc8", visualRegression:"a4c10f1b8a36a2f1c85a169b96fe65c55220879b5f0a9ac8158d355228304bc1", fixture:"cd2b4d11bf498cb0e207d81245de47b37ffc647ad81fd0d89ab9f83f33e49e85", mobile:"a19aa526a7b70b9a3e415386a5ceac478fe4b87c231c43a33fe886db17030bf0", tablet:"2f0f1c97e53bfc7a96ebae172d8f5f44ee374ca9fdddf096d4cc8ae76b045267", desktop:"b730ea1c4ec138f377c78c330b8634e1b5ebe10ea9586ad6dcc29dee460fe21c" },
  WarmHero: { schema:"fa3c8a015bba7d80897cc1b46d84068786969b8030f3c79c7e2b317459a043fb", variants:"3243e1b23773a87aa0edd4ddd7f85b2b0b8d087b689c1f375ef423bdd3a2e077", contentBudget:"1f57ddbb1cc02fa6c98c82e80c7de54fadd60da39818872a8d7e5151901b67cb", accessibility:"c7b9d8bf477d78beacb254f8e4a52ff757c28cedbd4c811efad1903f7f9590f3", reducedMotion:"4c5d28cdffd1e55eadfa6ab15426b60c5f72b8c469d75ee931db5244e5f56b63", fixtures:"6fe600b2206552284e1e0e7fd5915f430c6ea3509136f6b8516d5f8ad24980b8", visualRegression:"0b37bd1c193f4492a0cde38db6f2b37090eaa7e777366853b7539dba14f1ef46", fixture:"72e15ddab78cf2fa976baa6fa553538ebb24b68a8cc41ac5d7f7b535bd839f33", mobile:"14054f46cb7db37b7590565fc650212d06ce9bb08bcf45a9f1e59c5cf126de5c", tablet:"50c3e60a446cca986f93cdd837040f64278f05e8a5d5092ac64c41c7cfbee204", desktop:"c48351c346355684362544742d6bf42207c07c34cb89efac5558c32975211884" },
  DishesShowcase: { schema:"6c6fbe2d0f413f201e2aa58c92386b63f2b1a4ff240cb745640c799ef65d656c", variants:"8b6a25de592c1018fc16d2055277e909dc49032edc073419a87b2bbcfc109f54", contentBudget:"8cc85b77ddff637e8174543ee1e3ea1d678716bdc8042016454bc4957535530e", accessibility:"eb7106eea64f67f26fe808bb28f423aac2c2330a98b1b8fc2fe6cb2368818b31", reducedMotion:"e2844a0d7c26df59074ad42f95334cb1d676d2299cde0e814402002627043326", fixtures:"9a526be366c76b2726e25e43ac50bf58918572c9f9e0582cee9005293ba60741", visualRegression:"2e20e8895eba26dbeecb3f8d948ebf6fb6f8a0e3ac87b5993d3416c119e64b3f", fixture:"4375d31569a7a6997b0d6b5b9a6936df409084f6bb7670a923ac43ca6efef44e", mobile:"65334bc327221e616857cafb94641a255ab7afd950942eebbcd4586b5ef0483a", tablet:"5531d74638ab8134dd0485eff85b4e9a260494424f19de1c73278358ee7f19d3", desktop:"2d93226e7190dfc930456dff479db56f4124a42229b2a0d5905ba0af1cd77c9f" },
  PhotoGallery: { schema:"226ada2aead8b05cd5ef98b0515eaa16547f3e231b0ac61862c9175e59a70b45", variants:"1cf2138898b9c4c20c1731305599588f723ba240a0af589fc7f832e38051e5f0", contentBudget:"bba2d6299ea8dafbebaa0f22690cb5318bb8d49309a4e158d181f46747d4f5ac", accessibility:"4e2b03c503109566d45b930aadff1f9f481362997704cfa637324c9ae4decbf4", reducedMotion:"3893298f94a9edb84bc47afd5302b824d680c1112a1acdc3577742e181870247", fixtures:"d54b002bce173ae2e4bfbae1da3c8c02773d3ffe368acef3085563aefab1c68b", visualRegression:"ec62633f03f980496df67d2e49b791e71a71158811459fc9d45f1cb9e2c38689", fixture:"d540e6e12e105f5fa80867ffd07a2461dd76589c2e42ea1ad361b8ad4f6bc316", mobile:"57bcd1eb473356dd698f464d49f7bfd9eac5325c37af32d99ada05623c72a931", tablet:"aa2d93607896aa8dbfbc7640dd1bee0fd1c5b7a5a9a4e224f3849fd1652655d0", desktop:"d49a3d7e1566247b572091d64dfe718db8c4bb500afbdc8e8e89c35023c920fe" },
} as const;

const A11_SHA256 = {
  MediaCta: { schema:"89130bc9bf5b7e82e0233048ea0ea9b099dd612bef506896b232d84f890dc23b", variants:"9252e0ea005dd86677c16565d60280d616d2c0e8afc01e6e4f228ca17130dc65", contentBudget:"84850d18624760723078928ab9ff73e038d7385c08e0b4d59d91f6d17134477d", accessibility:"b66dbd2f7a34db5a37b940cfa037d54ea0a69f94a67747bfe88c1f9e75870734", reducedMotion:"d6da2c32a74fcd97a347643a0c784d04e5a0183c0e0333ae8be0d99e832b9634", fixtures:"b6e18ea6d1d51ff8cac77f82a430eebab9fc5f0fa1ddd7a79168591dd33c2368", visualRegression:"8c4ae72586d7f2882ba67a22846466d796ce529520efc0655096fdf4000e3121", fixture:"627d7e5653b807c1ab8862eb4266785a53e21b332e7dde9a15178f9c0a358300", mobile:"6232edad9b7ca98ea01af1b2f98d7ede9eb059ce67460647c3782bdf587611d5", tablet:"e33f36037b34dc4de11f31525f5d9bdb7d05423766cf65d70021312071ccbcea", desktop:"2533a5e872daeebf516497e957ffcdf70852637cc2ab1bf831f37ac2356f86e7" },
  FarmhouseHero: { schema:"3fb5a94313ffa339f49a8f8c0c25ce6296c7b5c666986b6d93512eeb6a634154", variants:"c8f928a64532267b6cf4c7fb4257db7f98998aca60b240009dce07c54edbaea6", contentBudget:"e9786fb882156fa9a9ee7353d91fd6eb9af89eb8a6420bf17f0281b2a0210920", accessibility:"4212a4ae6644ef74f9be16424524602115743f1371cbbc22c516db466a1eda73", reducedMotion:"7f0f8c3eb8bcaccd310e924724b2bc77cea76546887b50fc12c5a571d60da1d8", fixtures:"97327fa59699b75ce71c3d128e769a32ad6a6b2baa8da4ea0bdcfffd071d9100", visualRegression:"caca4c8b054c596cd3c5522ad36689de1ffbe9feb7467350ea41dd829ed65975", fixture:"2125a3b47f5d2c6773d9eb542ba44836f375334e8a84a142960196140ddbe93c", mobile:"1721e4f6b1d485b406ec480fec301c12d6984bc5b415e35b57f6cf750f7e0d1f", tablet:"a0e15008038d26ca42078e3a088d3df2d89c65868af19391d8823bacdceedf8a", desktop:"73cb8720a45986ad28e2d3452ff3e93819f91a791b5d4894912ce52b64fd528b" },
  FeaturedSpotlight: { schema:"2076593de9de05ee8de27a3e497f41b293427647f8bd6146cb03db13df9d3844", variants:"e5938f48654b150a54d960ed7ec1a567e157f35d7c4f20d5a1d5e609e8b4f043", contentBudget:"f1c2d1079475194fb82a7db9a4e10c67ee81292de044c83f6b7c55d6fcec0709", accessibility:"aa419737930a514f2431591d520298bf17c060241de1905d9603f31c3ce4f6b1", reducedMotion:"5ef3f8c98a8dc1f8306037d3c4f176f56f4e95a7aa64b82b6f190fd20560398e", fixtures:"8edda16b3f73e8f162a58309d1f8c5e2e057be1ee3d0ab82c90733d4d67d4c62", visualRegression:"3ff1d0edea649b04170007bbe47bceb8aedb23103c875b832b5beec3b29728d6", fixture:"862b5a8c93b8bf923384964da563505354e3f8fec8383b33770e54264c7fd767", mobile:"3ed3b402917ad4a341f8012e11007353f056233ebfd5a1b64226dab20fffcaad", tablet:"2873671a1e0da6c75cafe26f3806839f73455231a9faf347598f1eed119bebfb", desktop:"932fb27ea04d2b5ef087cb512ff41fb4ea60cd2a85345eb686a29ffb510e7f1f" },
  StoryChapters: { schema:"22ed6c846fa1d1c5faff5b9c26f67f292c6e894bb185033bb7aa1061d164a3fb", variants:"163bbf158be69d14784008ca9008707354f1897667c752cbd06b96903d73774e", contentBudget:"5ad233c07fb53edb7d517496f7ba0c25b3e4fad4243648cff8f9bd695ebc8f55", accessibility:"1ba21ccdb4788e396318eef4943053b0a0c3a60db23c0dc01d11abf58569275a", reducedMotion:"4ace03e7e91a480eed0075be9bf10d792571812aab08099467c15f9cb4e39f43", fixtures:"870d088eeeaa4b91295f04962269df041dbe4d78a9ea32056f78089629935323", visualRegression:"ca42664234eb8e4df1330cdf995fb8d07613ddbf0004f4ff03a15a8d5ccc15a8", fixture:"cab395546c5b0dad7f18e7f7024916db089aa345ef70c05ef21ffaf6b3d50d97", mobile:"d87d4629cf30b0d098f48d7401d634724d9b9f05b0f3bd9cdf8d5e1ccc57289c", tablet:"82e59fd224094443891830007fa7009bd4ae1d0a5810fe9b23a6cf075ad2519c", desktop:"ed4314822619696738cac2c8e08f41be89a498c84fde0d9ed761ec89d90f7dc1" },
  ChapterShowcase: { schema:"4af82ecbfe2ab02cc96f641a1830ca03295a7e4f9af214cb8a7031583cc4b9ca", variants:"bae661ac2f5c15da836dabcca0da248124a018ff29e4bb51f3293116c2c77803", contentBudget:"1fb3f20d61fcd782df0b85e1046547cedf94e1492ceaa4ce68c1b19866a7e4a9", accessibility:"083fff3054f1b134135ce7925159e96969280ca0e956a99de0bcf2206f45e25f", reducedMotion:"08c34d5c39f5a3f22b531941c12aee822b47799a4bf87e1aae7bb0cd245b8c42", fixtures:"ea971a72c2982ae38ebb84f43c304d6ef7d483006cb9f5f1daf84c8d68f9ff3a", visualRegression:"86cdf6197d8cc5e50450ac0e876030dc0d46b98968c4d1d5c06550ddd7fd0f90", fixture:"4c93ac0ae61c9d3b06f9c98e61d431e153e998d3c3083484628bf8f87b4348e5", mobile:"3b5aa1090718247000ae090b855d720fd254c69d07d5e7639fbc256fa486c32b", tablet:"ea614d4bf1afbae6a44a66f701593c4e9c9bc2c3b0cb7bf50485c5900b5f9d7f", desktop:"a5b636d7b0d2eb17474d9679ea3a236704556cdfdb794e317201fb928742cc20" },
} as const;

const A12_SHA256 = {
  DispatchHero: { schema:"80483cb214d31b916ae5133002ffaf7fd0bbcd9af13e8fecdc21b5c2261b82f2", variants:"9e3ab0af3c4662c43403caf01b3cb6cab3c5a32b14ed2ecb309a7f71f01d4f42", contentBudget:"78bf87fdb13f56b4efcdecc2d3569cd3b053d1120c80fbdd263c037ca6c5ee60", accessibility:"6b34b3a9e26a03b425f7871d1f0b7d737a4a1199f313e240170e48c7824a9a07", reducedMotion:"c8a7c8e851bacf1694bdf5991636181ba964676f23cda95e4af8cd41b748ea4b", fixtures:"b6853307822dd10df1637522088ad18821ff556f29970212648ac893cf16b58a", visualRegression:"acfe0543e1f34e9b6700f4d6c4f51fe217152a2c3890af3fec26a570c59cbc82", fixture:"2fc5f25bc36d925e95b123a7bce1f91ca10bee2260ae11a3927c98c68e98a720", mobile:"ac4025437c5b654576c5e9e99973dc0831d4490a419b17c35018c1d56c07c270", tablet:"321bfc111ba5302b3d5443ace426156a85a2438c7dbd90d096ffc23bc12af26d", desktop:"664713719df3be22397dfe6d192352eb0bda2edda559f44618be927bd7a65a1e" },
  ServicesEditorial: { schema:"387046adbac07e0e2e387a4037bb0e18b804ef53d61d810995dc089290e7d7c8", variants:"ec4d6e3792bb83b4d4dfcc62a89eb659307362917e43ed3217458e6c1de98152", contentBudget:"b6da0caa7ddde0da8ecf3c7ae5c0ec927878eec033d0b9907c94e7bfef89c78c", accessibility:"a0925223797ddd949148902f5511757efadf6d978417cec2c7fe83d59179657f", reducedMotion:"8bc6deef96021cf7a5258b051181901f1e5c26e2b2b567e04d1c18375ddadf8b", fixtures:"4ca68ea5ec998a7006bdf3bf0e675a7cda5b6722901591e63394b14481665b42", visualRegression:"ad1433e7e155ea9f8a468cdcaa39407216da0873e970c234c46091c359a9a0a7", fixture:"013c7c7068fc88c5d356ffd096d998168684b59bfd436dd750e4f9558d6a51b6", mobile:"f3876d2a16368b247bedf01c2b8ff307a6f158a514a4d63726c95904e581644f", tablet:"03bac1ef40f03d43f5463237b6315f663deae16b6ed4af8e255eacdef216fa21", desktop:"a0314592af21731b32de17634f28f42c5e7ca58924695a8b1932c2a1c3db5c30" },
  DispatchTimeline: { schema:"0965b286096320845ec5520a3e7ff414c0e62595d3a001d9a6326399ff62d3b3", variants:"3a4992ad399bee6d7f6369f0b1e12001f258de8a8eeb13b21a4d6cf80d8a66f3", contentBudget:"7f5f1d88ade5215b5d8649846c0d09738daaa59de35baeff048716ffe90b4651", accessibility:"b555bd9a78368c43f6567abd73c49d0f0f586e98d488749d82d3edcb808b7182", reducedMotion:"968f1d0762c836a201c6b484bcf1059f0d49aa05068ad34a3c5dc1a436c25c2c", fixtures:"e11cee15282462f6597f8a68c5e5de3c2898d33d3ef8c0672dbca5d6a8d614d4", visualRegression:"3ba01c69b9b0d92d82f2c6fad1c57ef3a0bb582688fafe78ae02c97442de8a2c", fixture:"193e024b9981b2d76244505469fe309a57c9c90cf79db046dcd13ae82a57bae6", mobile:"905b7f9e6e7a0118f6d9d29ab99cbd3d779e3e1cf22a99e0b550deec4a6063ef", tablet:"5405e5696d63bc2047c78df6a86f8ce8cf4f8a732a0b82f1849ddd197737afe0", desktop:"f82f2a1ef5ee3e4faefbdc73172f715dc9074a3eae59be205f13a779fb85b1b9" },
  CrewGrid: { schema:"f218d4db21838f6517c0c645e50d5339cad1430dde260631116d65ea1e72d036", variants:"290b6a9ba76dc2d72bba8011fbc4149e89b8f8a3b8e95b45e8e27a3809e77ebc", contentBudget:"87c2b16f1e2d12e44b3fa8a5c283420da7aab8649ace049f84daff1e69b8aaca", accessibility:"2f79013c5684ad73d1690621447777b916e47c1db83b864b5ff78d013afa39d6", reducedMotion:"9ee96255aab0c11c2faf09b0de61b1cda9018351e62ff62413807b268ba30672", fixtures:"574e4af7796bbd172fc765365de0c796e2ee8bdd80227f8074779f1eee3bd4b2", visualRegression:"9cce71ebae3823595f4644165194b0937b304a92fb8a6e49c4eac5a5ed0bfa12", fixture:"fcdda19366e9eb1d7f71d00a0745a3263aa783df4a253b4d3a17522eee9371ac", mobile:"cc6639530bacf5267eaf828afbe33b08a8b61ad4382f23bca3bf5dc15ff1eed8", tablet:"b44c233d120c67b617256b655646ad9a0260144f653ff2e83bfa77e4216c00bd", desktop:"39046951cccafbb3a9606f9ca4c81b85e7a11dcc4d970d16bcbfd67bcbc11990" },
  CoverageMap: { schema:"469370619fb009289231cb61f74f015577a0a3eee81f3fafc473f17c21112332", variants:"edd147397998a06995c9143f4b5acad583868eddc18127f6f60f4b90a906cca1", contentBudget:"4c3425cc57d68c37261c4689ae3c82da11063f9ba0ceef7aab4a5de28f20b46a", accessibility:"04697b76f10431688cc10af42ac4d387241cef99dbd4883e7a10bad1198ae8f6", reducedMotion:"cb9e198f9aeaaba8a24696cfa4b67eec41395f09e2defa29141b975af6cd0a69", fixtures:"b1c03c4f454768e125138c0cd507a3da6c6960f1f4c0da6ea5992befc0f31ef3", visualRegression:"f723a3d1e9b3eb50ead3e6f16444d5c34f42175c7a88bcf91b4ec5217ae431e5", fixture:"1e2a6d5e386d3542ef1910c494963fdad5188d8939019ce535993aec3bbe0ae6", mobile:"dcf93fe28e61ba0a65b04135a77a05745a6acb838ab79021cbe2a5589c7aeb2e", tablet:"030fa8ccf741377868d87da048fbaba01cd9a4c3d1e14834fb0672396f714125", desktop:"4b3f717ae108c55157161043004c1957972d2adcba47f2093e3167b4f9386c2f" },
} as const;

const A13_SHA256 = {
  HeroFull: { schema:"830af4dfb848f4af61c34177314d7386274f8174324413e40637dbceb71df199", variants:"c9bdae82ad9584fb8d0b154d19bf80fa637a5879c4a8a71c9e07bcb23f0dfa96", contentBudget:"40e84261ff2d9b0119c17450641b5a9672b5f278fe6f9a9e81bcb0a47f268221", accessibility:"ad86447573d46f616fe358dbba8fc3034b83821fc1fc41c2a2ef7c290214ee17", reducedMotion:"3088455f3ebc13326cffdd0182aa9c5426e277fc5adb60c0a3c5b9978e0c7f32", fixtures:"a88f966e0e774a011310cc411607089e28802602fc70b1fdf41174614125e175", visualRegression:"816373f14191dbcd1faa191f51870954d5d706f1cb76f37d5bc87572ff661227", fixture:"7ff507c5dd59093ae98ba077cf7d7a016c39b435f9ad67c5e6f71ee3c5003761", mobile:"05ff053173c636bcd88d4e445728d6fcb09441f73cb25a679e99e06dc4105562", tablet:"3c2d9be6cf3ee5adcb842d1cd250adcd32910b0b0c51a5a2c364230bbf96a9ce", desktop:"8f6df882594dc2dbf6311fa32a2976d2dda84117764663c6e59fa1ad72189ffa" },
  AxiomHero: { schema:"866d76a95df20825e48b4649dc3a616268e2435efe45f939fc69bf3c36094b0b", variants:"d5adc256739eb95d42f5e92f38a2dc84beaf1ba797528fbfcbc0eea871b8fb7d", contentBudget:"dafca9430092374fe53139e9727c975a24cfca2eb9c247eb8b71c23a16570193", accessibility:"d87841236ad8aede080f03f84b9b826483436d1c4173f8999b231b16246d584b", reducedMotion:"4f78d66bff1cb35a71593e9542b40bbf8e2456f910426d42f2cc3a114f038cb7", fixtures:"e4c15d939a31ca4e3415db30a54c693057cadd6d03f083ef709a20d56007a344", visualRegression:"77164e957f26e7d4d8ccb2bd9982544541b442ff1d5a43a49091e04f445521c7", fixture:"61cba628977712d454e4248a62ac57d4f43c21b3e571caba5589f0425bfa361e", mobile:"773e5b04fdfab9ffd1779cc479390d92a563813d73384a1c559123628a84d76d", tablet:"2acf0a1092f1a744bd4dbaa1d0edee4b77f91ac6d8785c908ca7bf4112476e60", desktop:"da6207aea9b94af95b3e9852a240c62c5cb3dba5b6fb97f7a66e3c774af2be15" },
  ColorwayPicker: { schema:"b6230f62c90a06cca828a2828101ec543d96f48b10b31deb29f83a089770ea12", variants:"a9105dcf29610b0c64d09657bd182cdfce34342bd2de90e1019500110e3fa5ee", contentBudget:"27dfe64fe177dcddf8e7dcbce8f0f760022853b30736279f0367ddb87a19c543", accessibility:"c35c900156e161afb8addba73b7967c0a98f1ab2b34b2d845ae9dc7d6816a365", reducedMotion:"4189e3fd0ba64f02b95a153ba656320f86c40d217699086b716a7e1aa6206b22", fixtures:"018d877e45c60d140c316966a79c411e26f130f06da754b055c5ac9e97bc8d28", visualRegression:"8bfb225bd7bc068954667ae45051590fd4eb77ac2e0b6b42a512335f0789d214", fixture:"3846fcaec7139f77168835ae0cf96d9df891475d091b42684877c823d0dc4b66", mobile:"5c9b22360e4c5426218f348728e303b62a36ac30adcb92de9b180c556f76f290", tablet:"ac951f3ca01443cac85b73bc3536510d3f6e6436e13a820f83b2518c91d8fc71", desktop:"3d8c9f717df7138c7be76bb47ea8e7f43147890e51065f2f2e7370e55ccf8c86" },
  SaaSHero: { schema:"9f5a39793142d70c3d46706be63afffa5cc0683933ccb0ce1c96baefd2d0f222", variants:"c8bd58af315b56af29bbeeacf883459c67dea809f279b03c6268215d3cec2145", contentBudget:"2740ebe288f25633ef2cf96776905db72610d7b6e01f9d2a00e2eb6f1a26c1f9", accessibility:"008172084256829d168c756a159608fc5ba9b61dc18eda4d8a2c9b3e1d42ab09", reducedMotion:"d8de76fd06d4098256b082a3c9f46ea346b53dff3c08e67be28b7f170c8b7dd1", fixtures:"ceb8a097e6d8e66315d993020d9e887d637e9d92a6216794db0916510e8d0fd5", visualRegression:"caf04e0582a5979e0a9c3d3beda97985c96ea6c207fc853d5e8a23c9aa4a562b", fixture:"b4dd044ce78ded12d96203d5980f72d2996d89fad6cf13bc38c1d4e667504d2b", mobile:"a375784b72a58dfbec80960c26f998a94d4c3ef85ef7b3a16ecac375c99b8d5d", tablet:"239ef67155c52cc99796db5a84f38af1b766b1a1c18282ba00a7179be5a77b05", desktop:"f6a113f251405c2862cae2c35d5bcbee8ad12b52c7f091d8502237adc179bbd4" },
  IndustrialHero: { schema:"18a3e6573af3650c67c559ec6166e22f6b46c5365fbf9542cdfc53c078993d36", variants:"4d65e94ec494a129057e0d76405dd9ce3460c1c8de56983c1d62470cbddbccb9", contentBudget:"edc0d8a58cd3a15952eb6ff821fee5f74bc6f3e13dc7b01625ae63071174fc58", accessibility:"4896ae73c76ddc0edb35ef3bc9c3700e7de0f58ce4910203bfa6b90485c7a726", reducedMotion:"e2d49ec473ff43c51caf2b047f4a96180bd6d6626e622f0e110edb9e23e7c832", fixtures:"4420f9e6d7452500c82976a63c70289f3e21b46238b50718150393e1ec1c6562", visualRegression:"e075ba80adb142e6543647ca95117a99beac4dce76c80ad691c8a5bfeadce5ac", fixture:"ed7208d5e2c2ac73582462bf201d96e067a887db99bcb6b13a228753554372f0", mobile:"a962c30646365ff16ca4390685dda97637ca970bebfd88abd82c73e005868900", tablet:"58ffc31deea8fae461c0ea06f2b7835955505e25437283d45a0b29d684ff1f32", desktop:"4ba65c1d09fe6af73ac079bf2f8426022beadf63331796c49f2897f9110f2a4a" },
  MinimalHero: { schema:"b5cbaccebf81d4ebcce58bc2a3020feeeb4a7466e702c82679978b8146ccf6df", variants:"08ac9fc4e4248c2e445b4a5af32062632c2ab447bbd7310755b5596eaf773db6", contentBudget:"5b9b62db08cbfe1a797f64e5ed5b217a9ce85cc7163edbe236bd859fa97abe11", accessibility:"e88735667ecaaedbc732f88912ee5e1b6b638b100104142f971c97445afb31bf", reducedMotion:"3767413592b6890b1ff185863a270ee5414b0d8a346c1bff89332335c3d16d33", fixtures:"85d24f8aef266ce6ebf19a4bf92c962e5ce53a7ada15988117c1bb207d06c4ab", visualRegression:"df629f4a3455f38e729c194ae5a03138c1f3f93e09f1a795b0611a70f78c3eea", fixture:"2e9e03bcca7df08d997524e1478f182018186d4fc1624000dbce0d9efeb7eac6", mobile:"101c6491741bb33c6d4294293199eb86c90d450f8c9e75b71077da50147e6319", tablet:"028b65e2c0156d1f49defdb97e621a282db6c17041aebee9ef85421a0e80ac35", desktop:"91c2bdd2ae598259bdde9a6ceac84ecfea6e161676eb9443dab66a45c2f425a6" },
} as const;

export const M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS = Object.freeze({
  "m1-e-a-cta-banner-schema": {
    artifactId: "m1-e-a-cta-banner-schema",
    componentType: "CtaBanner",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/schema.json",
    sha256: "71fdcb284094074b53f171ef3ed5ae28ae9a573668a5bd74c34fbb877bc37df6",
  },
  "m1-e-a-cta-banner-variants": {
    artifactId: "m1-e-a-cta-banner-variants",
    componentType: "CtaBanner",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/variants.json",
    sha256: "1e9daa851940ed8fd857e1cafc1ad43864c6e02470196f4f6aba70b666a1591d",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-cta-banner-content-budget": {
    artifactId: "m1-e-a-cta-banner-content-budget",
    componentType: "CtaBanner",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/content-budget.json",
    sha256: "b622ed183738fe4746c8ca37786f88b7906c670dfccb8c11552e6332b212c885",
  },
  "m1-e-a-cta-banner-accessibility": {
    artifactId: "m1-e-a-cta-banner-accessibility",
    componentType: "CtaBanner",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/accessibility.json",
    sha256: "40052d56da34e6e731dabc527ffa568c722d70cff892206e39da57a44e6f57a3",
  },
  "m1-e-a-cta-banner-reduced-motion": {
    artifactId: "m1-e-a-cta-banner-reduced-motion",
    componentType: "CtaBanner",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/reduced-motion.json",
    sha256: "fce46d3a2d366950908a1ac5fa741d8f5c59b4bb769e80f99107738ea70439bf",
  },
  "m1-e-a-cta-banner-fixtures": {
    artifactId: "m1-e-a-cta-banner-fixtures",
    componentType: "CtaBanner",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/fixtures.json",
    sha256: "ed65d90ff6629d7c66415b1e1fc0ccf310f54e4544625fc84b13251cecf680b8",
    fixtureIds: ["m1-e-a-cta-banner"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-cta-banner",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/cta-banner-spec.json",
        sha256:
          "78c9fadfcf97efe15229beaeb45e0c6c00f25f3d40549b632f49edb8b336e0c4",
      },
    ],
  },
  "m1-e-a-cta-banner-visual-regression": {
    artifactId: "m1-e-a-cta-banner-visual-regression",
    componentType: "CtaBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/visual-regression.json",
    sha256: "79f7fd718f4e3290d73238dd7a2bf2006c53fc294d11014f7dbe8bc89937550d",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CtaBanner.png",
        sha256:
          "ee3d65dd2d1c9ee5e512e3d928901552d251275a557a51eccf103da3eda0789d",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CtaBanner.png",
        sha256:
          "034d3ad556ea8dd794464a819e8622b4d1a0a677ac946e5ad93f9472a135c6b5",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CtaBanner.png",
        sha256:
          "a633ca169ceff22c9d2edcac170a046ad2ae848083c8dd127608fad36cb8a81a",
      },
    ],
  },
  "m1-e-a-hero-banner-schema": {
    artifactId: "m1-e-a-hero-banner-schema",
    componentType: "HeroBanner",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/schema.json",
    sha256: "2dec1c314b6d937b3c472f63c9cc989ff628cb31259edbe7c4ba3557d2503342",
  },
  "m1-e-a-hero-banner-variants": {
    artifactId: "m1-e-a-hero-banner-variants",
    componentType: "HeroBanner",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/variants.json",
    sha256: "7e4e58d9cc222c85f94f8855f7eb711521c42947c06885b3d75b3cdeea841136",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-hero-banner-content-budget": {
    artifactId: "m1-e-a-hero-banner-content-budget",
    componentType: "HeroBanner",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/content-budget.json",
    sha256: "0ef054b7aa89109d7ffbc6361e8ec8f72cd04e7d5dc6c61ec3163ffc79a38fe8",
  },
  "m1-e-a-hero-banner-accessibility": {
    artifactId: "m1-e-a-hero-banner-accessibility",
    componentType: "HeroBanner",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/accessibility.json",
    sha256: "13d0e3c64ac9850a13f99a3ec76a963a92b2b3f191aef5329878f9e9f184de9d",
  },
  "m1-e-a-hero-banner-reduced-motion": {
    artifactId: "m1-e-a-hero-banner-reduced-motion",
    componentType: "HeroBanner",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/reduced-motion.json",
    sha256: "f017916cb3579c1d54f0dafde8c286df94e12ad0073856243eec4c682776d5c0",
  },
  "m1-e-a-hero-banner-fixtures": {
    artifactId: "m1-e-a-hero-banner-fixtures",
    componentType: "HeroBanner",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/fixtures.json",
    sha256: "f51838d738de03a158c98b07746151879e9d6de6d2288de9555f3628ab745fc6",
    fixtureIds: ["m1-e-a-hero-banner"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-hero-banner",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/hero-banner-spec.json",
        sha256:
          "5e2c912bfb236056b6b06e86f219c8a23946b8a67d56fbcd6f75d91bb04ed03e",
      },
    ],
  },
  "m1-e-a-hero-banner-visual-regression": {
    artifactId: "m1-e-a-hero-banner-visual-regression",
    componentType: "HeroBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/visual-regression.json",
    sha256: "4c51bdf9c6c3c6de096d57ae41746e1ea64ad4aa2beb3f133445fe3d001ac874",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/HeroBanner.png",
        sha256:
          "554410a10a6273fef44079624c4adf6662e1a041056ed1df019baf21fe812cb7",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/HeroBanner.png",
        sha256:
          "cd25ca0a0dffb19d3e9be41d4b77275e6d1dccfbdfeb8968dbd17be735e97bf9",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/HeroBanner.png",
        sha256:
          "00873388b3679b449270c614ac7db1ac3d2d4770c98b2a99df56b720121a8aff",
      },
    ],
  },
  "m1-e-a-stats-band-schema": {
    artifactId: "m1-e-a-stats-band-schema",
    componentType: "StatsBand",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/schema.json",
    sha256: "0ae9d3db087c3b2cfee16bc85546506b0603d0d01f1893c8cc33267ed41915a2",
  },
  "m1-e-a-stats-band-variants": {
    artifactId: "m1-e-a-stats-band-variants",
    componentType: "StatsBand",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/variants.json",
    sha256: "1b6878faa2e4120ecb2b25e43fe4a3d8426d0cd0b5e477eb11bb7b05fe3d36f7",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-stats-band-content-budget": {
    artifactId: "m1-e-a-stats-band-content-budget",
    componentType: "StatsBand",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/content-budget.json",
    sha256: "f5720a09d4b055daf02dca306df3600ed90adc9be36b8947f5c577bd101dfc3b",
  },
  "m1-e-a-stats-band-accessibility": {
    artifactId: "m1-e-a-stats-band-accessibility",
    componentType: "StatsBand",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/accessibility.json",
    sha256: "413fac6de33fd4715a855a704de81c8ab921d6c70cc943e2c399cffbdcce78ba",
  },
  "m1-e-a-stats-band-reduced-motion": {
    artifactId: "m1-e-a-stats-band-reduced-motion",
    componentType: "StatsBand",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/reduced-motion.json",
    sha256: "8856e0c6a849a2352f124f32e39af56065f9546f248a3244d0a25f121eb6f69f",
  },
  "m1-e-a-stats-band-fixtures": {
    artifactId: "m1-e-a-stats-band-fixtures",
    componentType: "StatsBand",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/fixtures.json",
    sha256: "ea716469eabb1602e56eb78e1679520d98d6bc0330ce68063e451679d9aa87c0",
    fixtureIds: ["m1-e-a-stats-band"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-stats-band",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/stats-band-spec.json",
        sha256:
          "0385f26082bdf4c97df3a3fcd95a4f485a8127df5d2e7de60f675d36afadd295",
      },
    ],
  },
  "m1-e-a-stats-band-visual-regression": {
    artifactId: "m1-e-a-stats-band-visual-regression",
    componentType: "StatsBand",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/visual-regression.json",
    sha256: "c5592ada910fb0bd9a99b4e5073abef368a1c0a1bd6f96f588be76845c1492c6",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/StatsBand.png",
        sha256:
          "2614338b6f9c1d554f107efca66f4112e67f1d0f1740168fc54b5f287c4e0bf1",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/StatsBand.png",
        sha256:
          "5085a4e59d0f55e724a43b2ada84657c169faaafa9ffb2ed47e9659a234a5be1",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/StatsBand.png",
        sha256:
          "349241213ded4923389a46c08caaf74f44a1bf28e76e63bbd373e614c1c5b061",
      },
    ],
  },
  "m1-e-a-product-grid-schema": {
    artifactId: "m1-e-a-product-grid-schema",
    componentType: "ProductGrid",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/schema.json",
    sha256: "cf5adcb39edbd10b97330c41539db32c8b25e3a49211a747c61c9a71af1f702f",
  },
  "m1-e-a-product-grid-variants": {
    artifactId: "m1-e-a-product-grid-variants",
    componentType: "ProductGrid",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/variants.json",
    sha256: "7ce4a9e00f16570728c0ab6f20ed2be1e0508d2872d4c2c00f5e3f5c49609005",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-product-grid-content-budget": {
    artifactId: "m1-e-a-product-grid-content-budget",
    componentType: "ProductGrid",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/content-budget.json",
    sha256: "5946afa4bc957dfde67735f1e9e710cf61c505fb95bc7e4e511148558dad509a",
  },
  "m1-e-a-product-grid-accessibility": {
    artifactId: "m1-e-a-product-grid-accessibility",
    componentType: "ProductGrid",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/accessibility.json",
    sha256: "b835c8836cf222d0dc3ea4a114b8eec95ff6af15b25e8bddf02a555d0c4a386e",
  },
  "m1-e-a-product-grid-reduced-motion": {
    artifactId: "m1-e-a-product-grid-reduced-motion",
    componentType: "ProductGrid",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/reduced-motion.json",
    sha256: "c72bd6ea3ae5523becb995c42f0e58d50675a9ab2679ebbdcc04b69d63b2160e",
  },
  "m1-e-a-product-grid-fixtures": {
    artifactId: "m1-e-a-product-grid-fixtures",
    componentType: "ProductGrid",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/fixtures.json",
    sha256: "f22d325ea3dd976719d5fe836b75b971f7cd2a50ceef63fa4a428aa3741dfa99",
    fixtureIds: ["m1-e-a-product-grid"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-product-grid",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/product-grid-spec.json",
        sha256:
          "27f14e26db403da4a077f568863b0b91ef7e7989b95387147a377fd8ed89686b",
      },
    ],
  },
  "m1-e-a-product-grid-visual-regression": {
    artifactId: "m1-e-a-product-grid-visual-regression",
    componentType: "ProductGrid",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/visual-regression.json",
    sha256: "f6cf37dd0599fbf279be090e1f916959ce4af118f0c3a84a51f3c48a0864908c",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProductGrid.png",
        sha256:
          "bf20829740473f9c66b00c4c33915e73c19ac19b680f76913f193574a082cdd5",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProductGrid.png",
        sha256:
          "bda5ae6d9c556434d9ea575ade292b469355b225e259a65f62a2e6c1ac4c5e52",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProductGrid.png",
        sha256:
          "5a9efdce16a5be8719de119eb63f823110084013aba12259748603eb07b46932",
      },
    ],
  },
  "m1-e-a-about-block-schema": {
    artifactId: "m1-e-a-about-block-schema",
    componentType: "AboutBlock",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/schema.json",
    sha256: "a6c949da3597abb60c81d2ba552c9da94fc031bc4da27daf88f346a42fadc95e",
  },
  "m1-e-a-about-block-variants": {
    artifactId: "m1-e-a-about-block-variants",
    componentType: "AboutBlock",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/variants.json",
    sha256: "538ace7bb4adf58348dd5fc8b52fdee722f1d928128c693a7dffa9bd023e55c1",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-about-block-content-budget": {
    artifactId: "m1-e-a-about-block-content-budget",
    componentType: "AboutBlock",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/content-budget.json",
    sha256: "8760fabf8a469c9ea580d7512ad65d5f1841b783c08978b5277b2f59f01e3ae6",
  },
  "m1-e-a-about-block-accessibility": {
    artifactId: "m1-e-a-about-block-accessibility",
    componentType: "AboutBlock",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/accessibility.json",
    sha256: "c6af6db34cbdc3600a740cc7c64f7afd89c8f5350d30c97ef09eb14c8cc6e1ac",
  },
  "m1-e-a-about-block-reduced-motion": {
    artifactId: "m1-e-a-about-block-reduced-motion",
    componentType: "AboutBlock",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/reduced-motion.json",
    sha256: "77bc5823c1263beba8e2d900590306e403b0bb36bc2f00c24ffaae6fb7ff8cf2",
  },
  "m1-e-a-about-block-fixtures": {
    artifactId: "m1-e-a-about-block-fixtures",
    componentType: "AboutBlock",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/fixtures.json",
    sha256: "d93b039873e62940a24710320924733c0d181dd37a996665fc1d55493cd9e12f",
    fixtureIds: ["m1-e-a-about-block"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-about-block",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/about-block-spec.json",
        sha256:
          "fd5d2460ecf6e3382385430a1b9a1e698edc7f0f6fc40eafd826f19ed1625bcc",
      },
    ],
  },
  "m1-e-a-about-block-visual-regression": {
    artifactId: "m1-e-a-about-block-visual-regression",
    componentType: "AboutBlock",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/visual-regression.json",
    sha256: "64e1eb7418f8de415443659cdb1e5892bf62867013ae9f8b9b9c801bd17e315a",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/AboutBlock.png",
        sha256:
          "9b4a0a510b9b06728bb6d499d8d78c947e9f416700cc4fdadcb1bdf76a7a8248",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/AboutBlock.png",
        sha256:
          "111cd33901f2735bbf6a232d45e7dca99c3766e05b7a50db01bdd7ead757feac",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/AboutBlock.png",
        sha256:
          "f9d32d73602c1c3a80716a04615730befc1ccb695fa688033981b1ecc8d7ea8b",
      },
    ],
  },
  "m1-e-a-inquiry-form-schema": {
    artifactId: "m1-e-a-inquiry-form-schema",
    componentType: "InquiryForm",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/schema.json",
    sha256: "257fcf15bf04ef5a0bbe4a3ffd3143d80a63a13d72050936e043164f1d37daf7",
  },
  "m1-e-a-inquiry-form-variants": {
    artifactId: "m1-e-a-inquiry-form-variants",
    componentType: "InquiryForm",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/variants.json",
    sha256: "644c9f350ee7b3544da1f02b2866497a3377b65cb801ed595c19378589571eec",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-inquiry-form-content-budget": {
    artifactId: "m1-e-a-inquiry-form-content-budget",
    componentType: "InquiryForm",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/content-budget.json",
    sha256: "eda0a4b6efebb7d125343e3acf9ccf5ff5efa0a6f82ffa40cc1bc4634dd09722",
  },
  "m1-e-a-inquiry-form-accessibility": {
    artifactId: "m1-e-a-inquiry-form-accessibility",
    componentType: "InquiryForm",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/accessibility.json",
    sha256: "25c06eed227bfec41fb72088d9d4b9568df8e6d97093229dcc7737480028fa92",
  },
  "m1-e-a-inquiry-form-reduced-motion": {
    artifactId: "m1-e-a-inquiry-form-reduced-motion",
    componentType: "InquiryForm",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/reduced-motion.json",
    sha256: "2a95a71286296f134ed12e573ed47b72c297de2fc4ba06991b8458adbb8c2954",
  },
  "m1-e-a-inquiry-form-fixtures": {
    artifactId: "m1-e-a-inquiry-form-fixtures",
    componentType: "InquiryForm",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/fixtures.json",
    sha256: "4659678f0439d9a9222675345507c3e489b7845e41bf68f8204ae91128715417",
    fixtureIds: ["m1-e-a-inquiry-form"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-inquiry-form",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/inquiry-form-spec.json",
        sha256:
          "4b07a8e02732d237ee78ed942daff8dc2c88091752d0221cfeb5d5a1044a398f",
      },
    ],
  },
  "m1-e-a-inquiry-form-visual-regression": {
    artifactId: "m1-e-a-inquiry-form-visual-regression",
    componentType: "InquiryForm",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/visual-regression.json",
    sha256: "51ac4cc8504fc8f9e3e0fc035eea0e675c5768795db37b8fff31e68c08a474ee",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/InquiryForm.png",
        sha256:
          "8eed61ea8d4697c0a4d647fa48b7aadbaee2419a3bf6407c851b2d604810dd63",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/InquiryForm.png",
        sha256:
          "c8630d1a9efab27e23291166baa6bd7704bd18aa47c17ba9a37e2dd4bc9bc822",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/InquiryForm.png",
        sha256:
          "1f6f2a09f3037495cb9585b5040a24471392c0f949733839540a222e3d1b402e",
      },
    ],
  },
  "m1-e-a-cert-wall-schema": { artifactId: "m1-e-a-cert-wall-schema", componentType: "CertWall", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/schema.json", sha256: "2d222ece313dd34170691738009801de3534003b76b64d6be3bba95723e52a4e" },
  "m1-e-a-cert-wall-variants": { artifactId: "m1-e-a-cert-wall-variants", componentType: "CertWall", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/variants.json", sha256: "74ee31c22a399bd37e04160976abdcc494c60e9bb40368768db22cb1a1b78883", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-cert-wall-content-budget": { artifactId: "m1-e-a-cert-wall-content-budget", componentType: "CertWall", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/content-budget.json", sha256: "14deaed85ff805fa479e600435e8f979300e0c29279f6aec5ce5617de001fad0" },
  "m1-e-a-cert-wall-accessibility": { artifactId: "m1-e-a-cert-wall-accessibility", componentType: "CertWall", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/accessibility.json", sha256: "0924c8433483d6b7bb16d0f8750e12d58447f973e55fd3f558e2f78f0071845a" },
  "m1-e-a-cert-wall-reduced-motion": { artifactId: "m1-e-a-cert-wall-reduced-motion", componentType: "CertWall", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/reduced-motion.json", sha256: "c774550b663c7424e49210caee6987c4ee714127f71164eea847f031fc1eb5a7" },
  "m1-e-a-cert-wall-fixtures": { artifactId: "m1-e-a-cert-wall-fixtures", componentType: "CertWall", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/fixtures.json", sha256: "fab1bdcc2f1510b7d23ee941eb38f9418bc2d36ba0f7a0b08cb2dcdb852de019", fixtureIds: ["m1-e-a-cert-wall"], fixtureFiles: [{ fixtureId: "m1-e-a-cert-wall", repositoryPath: "apps/site-renderer/fixtures/component-qualification/cert-wall-spec.json", sha256: "c15d7f6caff45a6f13bff2fdf6af073456163ad952046ba94c4bd60e4ae22d10" }] },
  "m1-e-a-cert-wall-visual-regression": { artifactId: "m1-e-a-cert-wall-visual-regression", componentType: "CertWall", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/visual-regression.json", sha256: "8c02d27554e0cd45b61d1bd211e45555ae6b97abd5db22b797d1e248cdcbbdec", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CertWall.png", sha256: "27b07542f37296c89761a5745043cf9572045db5c4c3d17266b3777638d9ca4e" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CertWall.png", sha256: "086e8fc7deaab2f9313b2fc4e95100d3e986332670d2749938f9f62c71dd0e8f" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CertWall.png", sha256: "5d95704d52e4c139fb172c041f934cf73cbffc63286d8ef7745bd34c42c69ee1" }] },
  "m1-e-a-process-timeline-schema": { artifactId: "m1-e-a-process-timeline-schema", componentType: "ProcessTimeline", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/schema.json", sha256: "9e4ac3e3cccd56e7667108dfd45b338a7e62cbd7f6ffc51ecedd88e169420bf4" },
  "m1-e-a-process-timeline-variants": { artifactId: "m1-e-a-process-timeline-variants", componentType: "ProcessTimeline", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/variants.json", sha256: "d31f04ac02ca9e012a0ad116126e92cb8fb7252b137d5f4b4f4b9a2ae1beda61", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-process-timeline-content-budget": { artifactId: "m1-e-a-process-timeline-content-budget", componentType: "ProcessTimeline", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/content-budget.json", sha256: "c0f2df8fc46de0c690729dd947fa1e03849e95d111ee60320f215230c75d2e11" },
  "m1-e-a-process-timeline-accessibility": { artifactId: "m1-e-a-process-timeline-accessibility", componentType: "ProcessTimeline", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/accessibility.json", sha256: "d41dc582b5910b2e062d908587a392b9a4ee20dc692c91858b5c259b3975e1ae" },
  "m1-e-a-process-timeline-reduced-motion": { artifactId: "m1-e-a-process-timeline-reduced-motion", componentType: "ProcessTimeline", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/reduced-motion.json", sha256: "c7e20675b75fe371021a27d7da670ddca7d037c7c94f064b3a79f12a0d099c80" },
  "m1-e-a-process-timeline-fixtures": { artifactId: "m1-e-a-process-timeline-fixtures", componentType: "ProcessTimeline", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/fixtures.json", sha256: "606cbda89b9a85c439994f7a3d6bd6abfdab21e8f1483b0352fc9c0d8d581b8e", fixtureIds: ["m1-e-a-process-timeline"], fixtureFiles: [{ fixtureId: "m1-e-a-process-timeline", repositoryPath: "apps/site-renderer/fixtures/component-qualification/process-timeline-spec.json", sha256: "cdb8b14f17c4d302317123c681e76ef9556ba7880b329b1286132ddffd3ddd83" }] },
  "m1-e-a-process-timeline-visual-regression": { artifactId: "m1-e-a-process-timeline-visual-regression", componentType: "ProcessTimeline", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/visual-regression.json", sha256: "2137c7272bb2a5f7038085c204cb88a2f00bd464cd4f7d132c2e70cad9eb4917", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProcessTimeline.png", sha256: "8cbff12eb5bfedc635919dc09b0530aa156309b2ddfdc72e8cfd87422d755781" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProcessTimeline.png", sha256: "0a32a36a0581378d6316e54138b4dca3e35f25588ff051ab5de694381e1ed90d" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProcessTimeline.png", sha256: "aaddb34e6335f6c31ba51254fc017a9c530988c9849e481fd63fdbd9f0e8a1e5" }] },
  "m1-e-a-faq-accordion-schema": { artifactId: "m1-e-a-faq-accordion-schema", componentType: "FaqAccordion", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/schema.json", sha256: "700f4f0f6859d8a61470a780114500fc1a4ee2a0e4cf05472922b326836b2d65" },
  "m1-e-a-faq-accordion-variants": { artifactId: "m1-e-a-faq-accordion-variants", componentType: "FaqAccordion", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/variants.json", sha256: "8768f280f66e86564aab4976d1073120601873c2ede924123a75f95b66e4caeb", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-faq-accordion-content-budget": { artifactId: "m1-e-a-faq-accordion-content-budget", componentType: "FaqAccordion", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/content-budget.json", sha256: "69b568f65c01388cff491949c3b5be24a7350018ff834b32f993d0dd5cb1e50e" },
  "m1-e-a-faq-accordion-accessibility": { artifactId: "m1-e-a-faq-accordion-accessibility", componentType: "FaqAccordion", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/accessibility.json", sha256: "e26ef6bc3495320ea979e99120cbb2c67a193801a76b8fc6f6b6ce8a52464999" },
  "m1-e-a-faq-accordion-reduced-motion": { artifactId: "m1-e-a-faq-accordion-reduced-motion", componentType: "FaqAccordion", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/reduced-motion.json", sha256: "3c03341f4530613e41ad224cdfa1cda9e8cfed9a2dff8e3647d7368ce59472f1" },
  "m1-e-a-faq-accordion-fixtures": { artifactId: "m1-e-a-faq-accordion-fixtures", componentType: "FaqAccordion", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/fixtures.json", sha256: "7419a92419f6b98ebdad6a636d905c935d3c6244ab94ae1b5150b650ffaa44a4", fixtureIds: ["m1-e-a-faq-accordion"], fixtureFiles: [{ fixtureId: "m1-e-a-faq-accordion", repositoryPath: "apps/site-renderer/fixtures/component-qualification/faq-accordion-spec.json", sha256: "e2e11d8577738f8aa75f3e817cfbf735c9b56419dd3d25b9529468d5bfe37779" }] },
  "m1-e-a-faq-accordion-visual-regression": { artifactId: "m1-e-a-faq-accordion-visual-regression", componentType: "FaqAccordion", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/visual-regression.json", sha256: "93fcb96d9381e303920b6371ce0debe064863a1f9bc65763f5710d375a1702f5", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/FaqAccordion.png", sha256: "2254256a914947d8787ec1dfa73642a7ca422044aca99bfe4c4251af0588f6b7" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/FaqAccordion.png", sha256: "eabc7414ca42a5cf8e0fb6429fa66dd24c8c1204d60b9221c5b634544ba1aafd" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/FaqAccordion.png", sha256: "680f29ed89603809f4d2d2502b63dd1dccab42bec7057e701d3e5bc2f97f8fd5" }] },
  "m1-e-a-logo-marquee-schema": { artifactId: "m1-e-a-logo-marquee-schema", componentType: "LogoMarquee", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/schema.json", sha256: "906ff3fd388d7f2292da0cef131ed3f911d748f4038378dcec15dd0e66f4ea16" },
  "m1-e-a-logo-marquee-variants": { artifactId: "m1-e-a-logo-marquee-variants", componentType: "LogoMarquee", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/variants.json", sha256: "8ae2e75241a58d8085123313d7269a0d987c62eb02af99b6aef2e97098a10b1e", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-logo-marquee-content-budget": { artifactId: "m1-e-a-logo-marquee-content-budget", componentType: "LogoMarquee", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/content-budget.json", sha256: "9f1c474cff58d06b0f31982a8caec3f2dc521d11a227415d95cd7032a04c8cc2" },
  "m1-e-a-logo-marquee-accessibility": { artifactId: "m1-e-a-logo-marquee-accessibility", componentType: "LogoMarquee", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/accessibility.json", sha256: "169f999f722905f34a421f1d6aa47a17cd7bd9c00ac15e2574348667e9c6b160" },
  "m1-e-a-logo-marquee-reduced-motion": { artifactId: "m1-e-a-logo-marquee-reduced-motion", componentType: "LogoMarquee", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/reduced-motion.json", sha256: "75349066e00ebba8778e66171d3fb8eaf427d9bd71a519637fddb719f3f54f58" },
  "m1-e-a-logo-marquee-fixtures": { artifactId: "m1-e-a-logo-marquee-fixtures", componentType: "LogoMarquee", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/fixtures.json", sha256: "ed111c4e755f663772d4906729a70051e28921add469c5e34917bac5547b420f", fixtureIds: ["m1-e-a-logo-marquee"], fixtureFiles: [{ fixtureId: "m1-e-a-logo-marquee", repositoryPath: "apps/site-renderer/fixtures/component-qualification/logo-marquee-spec.json", sha256: "4f71a52397917533f325e217fc18c8228fd9bf7c260f7b5ec0dcabb6d5d7235f" }] },
  "m1-e-a-logo-marquee-visual-regression": { artifactId: "m1-e-a-logo-marquee-visual-regression", componentType: "LogoMarquee", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/visual-regression.json", sha256: "17458fe89e3ab5c8f6d651019b93e980a2d4dae74e780597b0f15353388f02b3", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/LogoMarquee.png", sha256: "3751d4dc86edfbe9ccd61c793cabdf918d627ab6d34af1c5b5d5215e5d2654ff" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/LogoMarquee.png", sha256: "7d95fde1b6aaedef05a5af34dfcaa7ca7872f3006a4e5adb3e87bc8b23ce1ddd" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/LogoMarquee.png", sha256: "efd0a37ab6d6473fd9e3b9f757c3d16c16a1ba4ba892a33137fd451094eb6cce" }] },
  "m1-e-a-testimonials-schema": { artifactId: "m1-e-a-testimonials-schema", componentType: "Testimonials", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/schema.json", sha256: "7c5965dca5b1ef6c046cd738beef747f7ed2779e078dfadf159476195bfabc7a" },
  "m1-e-a-testimonials-variants": { artifactId: "m1-e-a-testimonials-variants", componentType: "Testimonials", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/variants.json", sha256: "efe38e12d363723a3768bedc26fcf836460ca83f51995a65f9138de24ec02334", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-testimonials-content-budget": { artifactId: "m1-e-a-testimonials-content-budget", componentType: "Testimonials", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/content-budget.json", sha256: "fa958f190444c05d7f0419f838f07f929a0132ba7dbe1af370bca30da8122946" },
  "m1-e-a-testimonials-accessibility": { artifactId: "m1-e-a-testimonials-accessibility", componentType: "Testimonials", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/accessibility.json", sha256: "88269869af60e7c4e20cba9ff14f299a47b273ebbcee4e1f1b2e06e3866805e7" },
  "m1-e-a-testimonials-reduced-motion": { artifactId: "m1-e-a-testimonials-reduced-motion", componentType: "Testimonials", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/reduced-motion.json", sha256: "86655c0e5e6f1f4ec856af87f758a34ff668674d71614f2da641ad5af49a72ba" },
  "m1-e-a-testimonials-fixtures": { artifactId: "m1-e-a-testimonials-fixtures", componentType: "Testimonials", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/fixtures.json", sha256: "09892b3759987a733e0c2776cb298394ce0aa948c62c24a59b5daff2e7a52110", fixtureIds: ["m1-e-a-testimonials"], fixtureFiles: [{ fixtureId: "m1-e-a-testimonials", repositoryPath: "apps/site-renderer/fixtures/component-qualification/testimonials-spec.json", sha256: "7d14e2556beee78f1fddb823c67ebdc85cfa2de890066458a1052503755321a7" }] },
  "m1-e-a-testimonials-visual-regression": { artifactId: "m1-e-a-testimonials-visual-regression", componentType: "Testimonials", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/visual-regression.json", sha256: "10450f0faa1a91d34349991d02dd7b641a2b85e2b3865694d75787eee5205700", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/Testimonials.png", sha256: "81d10333c3872ddb0e03a0aa26a882efa85c0684ff7470936ae6eb7b9fe01880" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/Testimonials.png", sha256: "6c3ff2ac5c5b8abc93564e03b64efa6f93fafb1135975891e5435f2cd84e72a7" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/Testimonials.png", sha256: "37903f0e14acf6736785bd76df869bbeee358ae7d2babcd31effe21a6e3d1480" }] },
  "m1-e-a-feature-cards-schema": { artifactId: "m1-e-a-feature-cards-schema", componentType: "FeatureCards", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/schema.json", sha256: "f0005c0b9534e223428ee9e15206e0df84bb257fa70679b4f826a71c98b7212d" },
  "m1-e-a-feature-cards-variants": { artifactId: "m1-e-a-feature-cards-variants", componentType: "FeatureCards", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/variants.json", sha256: "70356b849b81169e0a7233472631c8436e66730138e823a27175658858071970", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-feature-cards-content-budget": { artifactId: "m1-e-a-feature-cards-content-budget", componentType: "FeatureCards", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/content-budget.json", sha256: "c0f6ddc81f4564c449b8606baf8b048a659ee5b78f882b909736b8366226c0bb" },
  "m1-e-a-feature-cards-accessibility": { artifactId: "m1-e-a-feature-cards-accessibility", componentType: "FeatureCards", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/accessibility.json", sha256: "7e7ee6a5b0adb87e2a42b99a9d09858000349c55ee38a530a8b97cc24666fca3" },
  "m1-e-a-feature-cards-reduced-motion": { artifactId: "m1-e-a-feature-cards-reduced-motion", componentType: "FeatureCards", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/reduced-motion.json", sha256: "b81560a4e5e7d54f09aa74c849af6e3a450fbc5dec7840d2a801e48646e19d8b" },
  "m1-e-a-feature-cards-fixtures": { artifactId: "m1-e-a-feature-cards-fixtures", componentType: "FeatureCards", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/fixtures.json", sha256: "477ca661f7b02f5fa215e5dd0053637102e3682417aeb5986ca6cc75389fef17", fixtureIds: ["m1-e-a-feature-cards"], fixtureFiles: [{ fixtureId: "m1-e-a-feature-cards", repositoryPath: "apps/site-renderer/fixtures/component-qualification/feature-cards-spec.json", sha256: "0b9616347ab440b2d1a2f00139984851a4c68927c08a953d3c5edec89c62b453" }] },
  "m1-e-a-feature-cards-visual-regression": { artifactId: "m1-e-a-feature-cards-visual-regression", componentType: "FeatureCards", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/visual-regression.json", sha256: "0d7e0e9cef36a63042195f6510d231045e0c4026bee7d13557f106a6948b92b1", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/FeatureCards.png", sha256: "3eecce7e91494c3345ae79f470308e9aa60d9e47721fdf0e1107cb66e6e96615" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/FeatureCards.png", sha256: "9d4f8d1fcce0d18bc32f28e829217db2d075fdf9d10578594491df6b800fe757" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/FeatureCards.png", sha256: "bb5ae079944ab9ac3013e5d9a9dc077e1a45d1ca9753922b7cc7e751636a904d" }] },
  "m1-e-a-tech-systems-schema": { artifactId: "m1-e-a-tech-systems-schema", componentType: "TechSystems", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/schema.json", sha256: "af56e3720c232311573403243ee26a56702d060f9e19b4a609084f177e2f6a95" },
  "m1-e-a-tech-systems-variants": { artifactId: "m1-e-a-tech-systems-variants", componentType: "TechSystems", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/variants.json", sha256: "05cbacec98163757ce85ae3ed0bae13d14d6342a044ad079fa6f2a54cbffbc55", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-tech-systems-content-budget": { artifactId: "m1-e-a-tech-systems-content-budget", componentType: "TechSystems", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/content-budget.json", sha256: "a2b35abb090df3442e447101cd6f09b9483a1d4561ffe250e5ade4c00e8baa0e" },
  "m1-e-a-tech-systems-accessibility": { artifactId: "m1-e-a-tech-systems-accessibility", componentType: "TechSystems", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/accessibility.json", sha256: "9e3ec6dbbd8413841045682976334dad1236e1f7185aabb109d80ca82e5373ee" },
  "m1-e-a-tech-systems-reduced-motion": { artifactId: "m1-e-a-tech-systems-reduced-motion", componentType: "TechSystems", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/reduced-motion.json", sha256: "a98e84fca450c50ddc8bb486705818473032ee62b4ac6a081fecb76b514a3ad3" },
  "m1-e-a-tech-systems-fixtures": { artifactId: "m1-e-a-tech-systems-fixtures", componentType: "TechSystems", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/fixtures.json", sha256: "80e66638911300b71f06723cb9dc5e5388ac04da5b3d06c06b6d26a3ed133051", fixtureIds: ["m1-e-a-tech-systems"], fixtureFiles: [{ fixtureId: "m1-e-a-tech-systems", repositoryPath: "apps/site-renderer/fixtures/component-qualification/tech-systems-spec.json", sha256: "807b3ab10ca3b263ff0b4385845c31180512b60c7ec96d857f7151ef4900565b" }] },
  "m1-e-a-tech-systems-visual-regression": { artifactId: "m1-e-a-tech-systems-visual-regression", componentType: "TechSystems", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/visual-regression.json", sha256: "c350799b3fd0243cb6f12c6063f59c417329c797321c301cd959caa34b83b76d", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/TechSystems.png", sha256: "e2b90b1289d4f94da8e5bc6936c32339fcc92dd0d1ddc714acba9c6b08de154a" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/TechSystems.png", sha256: "ed7897684d13e88ad20f59e07df27ec4e27f29e59f3a21f3efec356099b5d4ef" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/TechSystems.png", sha256: "a3a2437bc667469dd5f6d0bcc3cc83d4085e8d4d28957652c016f40e8c58b0c7" }] },
  "m1-e-a-map-location-schema": { artifactId: "m1-e-a-map-location-schema", componentType: "MapLocation", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/schema.json", sha256: "e2b9e9a09a7cedc2d74abc1b57281cd9251c803a790f204adb3559a71fe3ce79" },
  "m1-e-a-map-location-variants": { artifactId: "m1-e-a-map-location-variants", componentType: "MapLocation", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/variants.json", sha256: "3e2a5430f8d586f0cfdd8cbf349c1051109fcd5aba10e7e95dfc71c54b434ae8", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-map-location-content-budget": { artifactId: "m1-e-a-map-location-content-budget", componentType: "MapLocation", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/content-budget.json", sha256: "8617900fe04a145aeb2c1190c12ecee45387989e8f6f95520b19ad28cda3c1d7" },
  "m1-e-a-map-location-accessibility": { artifactId: "m1-e-a-map-location-accessibility", componentType: "MapLocation", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/accessibility.json", sha256: "f52a1b1cb5601ec3d0cc1d7029efe09cd7f9d9ff708087efecbad3aac40c2a54" },
  "m1-e-a-map-location-reduced-motion": { artifactId: "m1-e-a-map-location-reduced-motion", componentType: "MapLocation", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/reduced-motion.json", sha256: "8dadddd246d5b690aae19ea96092d714182ebd3d93a9ad48e0e4d7e2f6e75b8b" },
  "m1-e-a-map-location-fixtures": { artifactId: "m1-e-a-map-location-fixtures", componentType: "MapLocation", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/fixtures.json", sha256: "cf0f4d458fff7f5338848f921a9aa834fb375f3731f5d45d133e8f9591a10b36", fixtureIds: ["m1-e-a-map-location"], fixtureFiles: [{ fixtureId: "m1-e-a-map-location", repositoryPath: "apps/site-renderer/fixtures/component-qualification/map-location-spec.json", sha256: "7a773b1b1c4470684120685f36460c63d0d78e553bd24966a43313cdeca96293" }] },
  "m1-e-a-map-location-visual-regression": { artifactId: "m1-e-a-map-location-visual-regression", componentType: "MapLocation", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/MapLocation/visual-regression.json", sha256: "73e8942027ea4a71399691d9941d179c8cb7c49d7494ebf57c38bd4d896c5855", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/MapLocation.png", sha256: "13fdb4516a9ba86ce7edc06f00d17c45a5b497e1c936e6626316ca89cd465db7" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/MapLocation.png", sha256: "8eeecc3e199c73e0209a59cd9dcad1f88cc2b52c04662e3a62f5a74b28217198" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/MapLocation.png", sha256: "f36c1c07768a60bfec72a00a6c70ed2a6aa4d6a1610c79db5b3683d035fede2e" }] },
  "m1-e-a-services-grid-schema": { artifactId: "m1-e-a-services-grid-schema", componentType: "ServicesGrid", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/schema.json", sha256: "d45e1cfbc92ec2038b1a882bb9f910bb69c1f5935a0853dfca257af007683f34" },
  "m1-e-a-services-grid-variants": { artifactId: "m1-e-a-services-grid-variants", componentType: "ServicesGrid", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/variants.json", sha256: "ce74157cdb18dba22d10c3d2353714edb4e57e3f69718c0f3bd030bff08041fe", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-services-grid-content-budget": { artifactId: "m1-e-a-services-grid-content-budget", componentType: "ServicesGrid", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/content-budget.json", sha256: "be3ffe2194a4533125d61f7dde907da5178e2b5612c99edab2ea02ba32747c08" },
  "m1-e-a-services-grid-accessibility": { artifactId: "m1-e-a-services-grid-accessibility", componentType: "ServicesGrid", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/accessibility.json", sha256: "3dba4dc74df4885c92d8023c1cb0b77484e69c8132e7a483267e3551678e7db2" },
  "m1-e-a-services-grid-reduced-motion": { artifactId: "m1-e-a-services-grid-reduced-motion", componentType: "ServicesGrid", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/reduced-motion.json", sha256: "fcb7ab59f516fb663197cad9d4894dc0d2ece113a24e05d6a6cdea5e31754acd" },
  "m1-e-a-services-grid-fixtures": { artifactId: "m1-e-a-services-grid-fixtures", componentType: "ServicesGrid", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/fixtures.json", sha256: "3e301039b6a3a764b589c4d1abd88b9725c497a4e13d0acff02ac042b0f81f39", fixtureIds: ["m1-e-a-services-grid"], fixtureFiles: [{ fixtureId: "m1-e-a-services-grid", repositoryPath: "apps/site-renderer/fixtures/component-qualification/services-grid-spec.json", sha256: "a7b4b495f058889663f4817d9c322850e9bdab3db0bfed936b9773c86d7836cc" }] },
  "m1-e-a-services-grid-visual-regression": { artifactId: "m1-e-a-services-grid-visual-regression", componentType: "ServicesGrid", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesGrid/visual-regression.json", sha256: "ca1abc7732e8acb8819a2775ef0526a5a5d6fa02088b3a3021f18dc92c794d52", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ServicesGrid.png", sha256: "14743faf9b1d43878f1b9fe3078c107016b1ac880c83fb6511b36a4787052322" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ServicesGrid.png", sha256: "bc3827af257590a109c24e27f072f58bf1bda72757c2b07e17990b90f86ca371" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ServicesGrid.png", sha256: "2a21bf26affed65552ff92f11b63c170c218d3b74ee60ecc931b6943059b9543" }] },
  "m1-e-a-trust-split-schema": { artifactId: "m1-e-a-trust-split-schema", componentType: "TrustSplit", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/schema.json", sha256: "6f95b94217c6aeb8adab17bba1ed20434aaac0a7addce3effd9e8c332ff8cba8" },
  "m1-e-a-trust-split-variants": { artifactId: "m1-e-a-trust-split-variants", componentType: "TrustSplit", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/variants.json", sha256: "5cf25cfae7fc83fa4196dead9980f0c5abfdf56165b17607012265315010f47e", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-trust-split-content-budget": { artifactId: "m1-e-a-trust-split-content-budget", componentType: "TrustSplit", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/content-budget.json", sha256: "6407b46f7facccc1bf2ca88c67cea9362e00137df77b7ba373339dd7cc115798" },
  "m1-e-a-trust-split-accessibility": { artifactId: "m1-e-a-trust-split-accessibility", componentType: "TrustSplit", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/accessibility.json", sha256: "c74942827ea5564903f94fd899c5d243b23b3377cc7411f8bf3dee995ef21551" },
  "m1-e-a-trust-split-reduced-motion": { artifactId: "m1-e-a-trust-split-reduced-motion", componentType: "TrustSplit", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/reduced-motion.json", sha256: "e131046785d643b9a3471213b6748ac804d03d7fdb2e00b713b6ea75f35ef68c" },
  "m1-e-a-trust-split-fixtures": { artifactId: "m1-e-a-trust-split-fixtures", componentType: "TrustSplit", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/fixtures.json", sha256: "61677a19822bfde1f2ca1aa15cd1c581fad942f202b4b516b563499c8f8049c3", fixtureIds: ["m1-e-a-trust-split"], fixtureFiles: [{ fixtureId: "m1-e-a-trust-split", repositoryPath: "apps/site-renderer/fixtures/component-qualification/trust-split-spec.json", sha256: "5f1448ca2dee530ea289c77a3f893d767ec7d41713faf6fd2919c41af79d0c76" }] },
  "m1-e-a-trust-split-visual-regression": { artifactId: "m1-e-a-trust-split-visual-regression", componentType: "TrustSplit", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/TrustSplit/visual-regression.json", sha256: "791ef779ef08c027f09f2f0c250b81efc1dbc77512b0652eda60a5aca5660a7d", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/TrustSplit.png", sha256: "a798c35fa4eac03a829828c3dfc7963b7c922c4f0e08db6bb83dd1bf2371eaa8" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/TrustSplit.png", sha256: "7379b0b9c94215b325541fba2e44a6c9b8223990d0770859de1abd3e4922b417" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/TrustSplit.png", sha256: "f7e1fd1e566bfa22579d3df750ec09783880f8b61441fc6437bb675925a77526" }] },
  "m1-e-a-process-steps-schema": { artifactId: "m1-e-a-process-steps-schema", componentType: "ProcessSteps", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/schema.json", sha256: "f91134ba5da36195829d5ecabba544fb44907017d5688739ae4810042c856f00" },
  "m1-e-a-process-steps-variants": { artifactId: "m1-e-a-process-steps-variants", componentType: "ProcessSteps", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/variants.json", sha256: "6ef3b5ea5ba6540e26bd033fc68cc38923a69dc1204e89589e4a5869c9136fc9", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-process-steps-content-budget": { artifactId: "m1-e-a-process-steps-content-budget", componentType: "ProcessSteps", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/content-budget.json", sha256: "964773e6455de9fac997b7025abffbdcd172dcad4afca05b30d8ade0646df419" },
  "m1-e-a-process-steps-accessibility": { artifactId: "m1-e-a-process-steps-accessibility", componentType: "ProcessSteps", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/accessibility.json", sha256: "4a917046496d65e1e45d095b5b44713798c80217816608f2193f17b0dfe9fcfc" },
  "m1-e-a-process-steps-reduced-motion": { artifactId: "m1-e-a-process-steps-reduced-motion", componentType: "ProcessSteps", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/reduced-motion.json", sha256: "922cafa1599a3ba1a8e2fd807814049999becf5d300b75848a8ab5c1dc8ff914" },
  "m1-e-a-process-steps-fixtures": { artifactId: "m1-e-a-process-steps-fixtures", componentType: "ProcessSteps", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/fixtures.json", sha256: "6ddf65d5c220d9a9657e5d3cf596b5ef3e14f687eaa9151f50b115e2777e4988", fixtureIds: ["m1-e-a-process-steps"], fixtureFiles: [{ fixtureId: "m1-e-a-process-steps", repositoryPath: "apps/site-renderer/fixtures/component-qualification/process-steps-spec.json", sha256: "4a15571db7a6a7bedb1654792f209da4d132f5c3e13f732c9d62150ed1300371" }] },
  "m1-e-a-process-steps-visual-regression": { artifactId: "m1-e-a-process-steps-visual-regression", componentType: "ProcessSteps", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessSteps/visual-regression.json", sha256: "ff5afc1e1206569690453e2942ef2501569a7d556408cbb41c14ddbf4dcde67c", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProcessSteps.png", sha256: "60edf4f9b33985f763541a0dfd81c2ee7a8eef00f1db1d1f68c61fb983b37e6b" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProcessSteps.png", sha256: "df36782d281d58478e185027c29861d8aaee06ec1dce59f5e8a9a59bfff228f9" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProcessSteps.png", sha256: "56eaedb311bd0c53ad5cb9da5897b3ec803e9d15712ad31891af8809f505ab79" }] },
  "m1-e-a-article-grid-schema": { artifactId: "m1-e-a-article-grid-schema", componentType: "ArticleGrid", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/schema.json", sha256: "9cd58777e1f1d415b4e7d74c5ba20ba11b175a902b50aa3dc457473644679b6f" },
  "m1-e-a-article-grid-variants": { artifactId: "m1-e-a-article-grid-variants", componentType: "ArticleGrid", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/variants.json", sha256: "58f49444796c27e7221342a2a683175b06529d7929c6e418f58914b2b1fed900", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-article-grid-content-budget": { artifactId: "m1-e-a-article-grid-content-budget", componentType: "ArticleGrid", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/content-budget.json", sha256: "cba2593fd08fc80a5faaddf8c6d2bcdb025304eb89689b449360c85126b06bbf" },
  "m1-e-a-article-grid-accessibility": { artifactId: "m1-e-a-article-grid-accessibility", componentType: "ArticleGrid", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/accessibility.json", sha256: "fcfd0071466963d8cf14a44aa1ff146816a958c9a6508128cd6dd7d5fc181a90" },
  "m1-e-a-article-grid-reduced-motion": { artifactId: "m1-e-a-article-grid-reduced-motion", componentType: "ArticleGrid", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/reduced-motion.json", sha256: "51fdedb18a567391d03044273bea4d551d1a714c29ea6d1167e2bbffb02bb52c" },
  "m1-e-a-article-grid-fixtures": { artifactId: "m1-e-a-article-grid-fixtures", componentType: "ArticleGrid", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/fixtures.json", sha256: "72ddf08993ae516607665d4e88fc3ecc6d18788d4a1f2db341e525603ec5efad", fixtureIds: ["m1-e-a-article-grid"], fixtureFiles: [{ fixtureId: "m1-e-a-article-grid", repositoryPath: "apps/site-renderer/fixtures/component-qualification/article-grid-spec.json", sha256: "ed34d3dd092236905a7b6b35958fa683b26b8d1c13466bf4b0cdc11e4291bf2e" }] },
  "m1-e-a-article-grid-visual-regression": { artifactId: "m1-e-a-article-grid-visual-regression", componentType: "ArticleGrid", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ArticleGrid/visual-regression.json", sha256: "c1acff6321d009931dab516a9279bca304cc7537292ac925b1388968126667d7", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ArticleGrid.png", sha256: "fb20854c2df6dac283ff855c5dec27fb72da09d5dfd6e2155e00ffccc45b350d" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ArticleGrid.png", sha256: "d16d1e61ba29e73e01e194e16db72312bd7db97e9e840f24a84854ffd74845e5" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ArticleGrid.png", sha256: "d334d91840b87e7b9739ba1f4aef2f89711045af34fd397a14249ea5e3004d2f" }] },
  "m1-e-a-statement-block-schema": { artifactId: "m1-e-a-statement-block-schema", componentType: "StatementBlock", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/schema.json", sha256: "a9cbb25e34a6a3686a99c27f262c2dca0d758e5bed2dcd634be7cc12d1127cf9" },
  "m1-e-a-statement-block-variants": { artifactId: "m1-e-a-statement-block-variants", componentType: "StatementBlock", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/variants.json", sha256: "a16adeba0d9c3206ba4953eeff448007c33cb5e5c39b66820cb9410cdfedd7da", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-statement-block-content-budget": { artifactId: "m1-e-a-statement-block-content-budget", componentType: "StatementBlock", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/content-budget.json", sha256: "36b75785422fa707cfe8889192d9320dfa86a49d6bd04516b6ebc03ce5f415e8" },
  "m1-e-a-statement-block-accessibility": { artifactId: "m1-e-a-statement-block-accessibility", componentType: "StatementBlock", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/accessibility.json", sha256: "76b98b5f8a7cbd2964872a9029b9722b3d4fc4ab4b3dbd920c2da15783c44c00" },
  "m1-e-a-statement-block-reduced-motion": { artifactId: "m1-e-a-statement-block-reduced-motion", componentType: "StatementBlock", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/reduced-motion.json", sha256: "209f8f5bff36e05372a8df2c47fd64754abab9f9388d0b836ed3461802368cbe" },
  "m1-e-a-statement-block-fixtures": { artifactId: "m1-e-a-statement-block-fixtures", componentType: "StatementBlock", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/fixtures.json", sha256: "7e190663f72504cf4805420908b254d7e768baa0fdac7530e082b60d66d7ae51", fixtureIds: ["m1-e-a-statement-block"], fixtureFiles: [{ fixtureId: "m1-e-a-statement-block", repositoryPath: "apps/site-renderer/fixtures/component-qualification/statement-block-spec.json", sha256: "73aa05d631c4fdabbaff64a5629089d288f21209de5699655b9bc465ce9d3663" }] },
  "m1-e-a-statement-block-visual-regression": { artifactId: "m1-e-a-statement-block-visual-regression", componentType: "StatementBlock", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/StatementBlock/visual-regression.json", sha256: "eb9142fa18332fa841f596b8ee23cac3c8c03b59829d9006b408482e3a617a67", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/StatementBlock.png", sha256: "16e5f151c3a87a55f689cbad0fa54cec64a7ee390eb9e2883bdf39462e706fd9" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/StatementBlock.png", sha256: "a928ae955f9b5687d08c2a009754ac320cb77f2b2195edf202f254feedd83ede" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/StatementBlock.png", sha256: "fb7df0938353ff99edfca5cb8005e9a4f879a0eb69f4253996916a061c5a59bb" }] },
  "m1-e-a-pricing-table-schema": { artifactId: "m1-e-a-pricing-table-schema", componentType: "PricingTable", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/schema.json", sha256: "fced444e566ded61777a59d14d3d5784d61bc4353504fb7f11846ee3d307a5dc" },
  "m1-e-a-pricing-table-variants": { artifactId: "m1-e-a-pricing-table-variants", componentType: "PricingTable", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/variants.json", sha256: "7ad48f2e471e71433ac0444f824ccef0359439024f74161fe6b8d3de2ad2a6fb", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-pricing-table-content-budget": { artifactId: "m1-e-a-pricing-table-content-budget", componentType: "PricingTable", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/content-budget.json", sha256: "a0051d2cd1b8dc632af5b849442b7f6b8116b255e57628782b4cb6c9b63fde05" },
  "m1-e-a-pricing-table-accessibility": { artifactId: "m1-e-a-pricing-table-accessibility", componentType: "PricingTable", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/accessibility.json", sha256: "a6bb5edc82622dd11e3e1638e684735d7c61a79ad82601ec6b5fe9520edbe822" },
  "m1-e-a-pricing-table-reduced-motion": { artifactId: "m1-e-a-pricing-table-reduced-motion", componentType: "PricingTable", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/reduced-motion.json", sha256: "4cab330c2473ed1d22a8b799f464f92ceca9b3642e7ea97feeaba2712e121798" },
  "m1-e-a-pricing-table-fixtures": { artifactId: "m1-e-a-pricing-table-fixtures", componentType: "PricingTable", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/fixtures.json", sha256: "767398a16fd89e1032d4611b0356dfffdc791988b2d97351ca03dea8e37760e7", fixtureIds: ["m1-e-a-pricing-table"], fixtureFiles: [{ fixtureId: "m1-e-a-pricing-table", repositoryPath: "apps/site-renderer/fixtures/component-qualification/pricing-table-spec.json", sha256: "be699e53bf9b990429c56a2dc46b5027e72c80a7cf4d4d098e00f62dcdb4a988" }] },
  "m1-e-a-pricing-table-visual-regression": { artifactId: "m1-e-a-pricing-table-visual-regression", componentType: "PricingTable", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTable/visual-regression.json", sha256: "8896aedc5f063b405c874719f6a5ba47306c4b1154743dd9dad3e5d3975bf190", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/PricingTable.png", sha256: "a6bb4e12a697e7286ad48ee17b824dc46656d6db9718fc120ac04999612b7c42" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/PricingTable.png", sha256: "fe4fcee67d60bc6dacc6cf1d168e6edb552874d86497717ae79805ab920396b7" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/PricingTable.png", sha256: "64771bd0a1d4d8378fbd9686c47d48fbada9610170d7cc649f930d89fef98eeb" }] },
  "m1-e-a-stats-countup-schema": { artifactId: "m1-e-a-stats-countup-schema", componentType: "StatsCountup", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/schema.json", sha256: "360589e67c2d6926b060c28d79f4b6fa24420df3b74603e24ba24e2312eb6950" },
  "m1-e-a-stats-countup-variants": { artifactId: "m1-e-a-stats-countup-variants", componentType: "StatsCountup", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/variants.json", sha256: "cf27f0c3a117f4ad6509dae9226d556922c15f2ae6848d5b6afaf0588a356444", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-stats-countup-content-budget": { artifactId: "m1-e-a-stats-countup-content-budget", componentType: "StatsCountup", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/content-budget.json", sha256: "dad1ecc7bcc2c1c518ea3cf5a7740680d5835b42e4f64dfe9bd9a10de8fdc5f0" },
  "m1-e-a-stats-countup-accessibility": { artifactId: "m1-e-a-stats-countup-accessibility", componentType: "StatsCountup", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/accessibility.json", sha256: "db9efc7ccbcbad07f12b8084dbc7c92974785a30481697cac5d48f3f984c9c19" },
  "m1-e-a-stats-countup-reduced-motion": { artifactId: "m1-e-a-stats-countup-reduced-motion", componentType: "StatsCountup", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/reduced-motion.json", sha256: "4774afac69a879479284d34be3b9e5879404a2a6e4a0941302972681e366906b" },
  "m1-e-a-stats-countup-fixtures": { artifactId: "m1-e-a-stats-countup-fixtures", componentType: "StatsCountup", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/fixtures.json", sha256: "e68d0ba8c0a9c8fa6316a5df0e4a9b3aaf82acec2b48a3e413a7582a11801736", fixtureIds: ["m1-e-a-stats-countup"], fixtureFiles: [{ fixtureId: "m1-e-a-stats-countup", repositoryPath: "apps/site-renderer/fixtures/component-qualification/stats-countup-spec.json", sha256: "f4c46c7f93d40e8c17ae8f07962078a28ef6329ace4f087bd572f5866fdb58a2" }] },
  "m1-e-a-stats-countup-visual-regression": { artifactId: "m1-e-a-stats-countup-visual-regression", componentType: "StatsCountup", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/StatsCountup/visual-regression.json", sha256: "18f7c2d7a6bdc9257a7b801b22e4d5593d70fb7cd87f64bf30c5df1010cd2031", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/StatsCountup.png", sha256: "c4df9ebdde26e7182e3c49c191cdace6d5ba15d774684d46edffb5218a4e55b8" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/StatsCountup.png", sha256: "9f1c7ff854a5d0e7b04d2c08d5d852fe105164986ea2f60140b1667c5cb0182a" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/StatsCountup.png", sha256: "40acfbed46552e7b64a126279bc87af7c0cc8c66541b41ddaa9b19fccd23bfc7" }] },
  "m1-e-a-ledger-stats-schema": { artifactId: "m1-e-a-ledger-stats-schema", componentType: "LedgerStats", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/schema.json", sha256: "92c74884e287d75556e2d52b662f03fdbb6cc5d71dff3ee3918690e6dcae2ac7" },
  "m1-e-a-ledger-stats-variants": { artifactId: "m1-e-a-ledger-stats-variants", componentType: "LedgerStats", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/variants.json", sha256: "b81c142eb47d17f72b78784bf9965796636a9aa52a883769540138630c543fb4", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-ledger-stats-content-budget": { artifactId: "m1-e-a-ledger-stats-content-budget", componentType: "LedgerStats", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/content-budget.json", sha256: "019e54c1502e3d790a9238b5ad3d59a954cf43e53bd0076e6f3c4ac3522b3d13" },
  "m1-e-a-ledger-stats-accessibility": { artifactId: "m1-e-a-ledger-stats-accessibility", componentType: "LedgerStats", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/accessibility.json", sha256: "39c5706aad6a7a8ac99360f15f76939147fae39633d708b83b880c03140d6b66" },
  "m1-e-a-ledger-stats-reduced-motion": { artifactId: "m1-e-a-ledger-stats-reduced-motion", componentType: "LedgerStats", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/reduced-motion.json", sha256: "6271ec21df8becefae56b8551bd0b31e9a4a2424e5362721a51443800776abfb" },
  "m1-e-a-ledger-stats-fixtures": { artifactId: "m1-e-a-ledger-stats-fixtures", componentType: "LedgerStats", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/fixtures.json", sha256: "356dcaada6d0b5de86cc4d0e6322c9ed9985a1e48454cd38e022e3fef73db281", fixtureIds: ["m1-e-a-ledger-stats"], fixtureFiles: [{ fixtureId: "m1-e-a-ledger-stats", repositoryPath: "apps/site-renderer/fixtures/component-qualification/ledger-stats-spec.json", sha256: "0cb9ac67fa2171b157287164fce0fab4e6d59f47a82a3b626e34f6eda058564f" }] },
  "m1-e-a-ledger-stats-visual-regression": { artifactId: "m1-e-a-ledger-stats-visual-regression", componentType: "LedgerStats", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/LedgerStats/visual-regression.json", sha256: "d1472e34d32fad150c0943adc66713dce13c0f560545420488afecb86f6b09d0", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/LedgerStats.png", sha256: "65164d68243b9cfef934442554223fffbe892397d2403389c593fff745d48f8a" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/LedgerStats.png", sha256: "62bf305c7d731750b16963723904dc3468fed0967b42dc252c3b3e9b25233587" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/LedgerStats.png", sha256: "7b90fb0690d38ffbad0aa1ce1f134dad1d2c312d9217fb263247d380a03b1bb5" }] },
  "m1-e-a-pricing-tiers-schema": { artifactId: "m1-e-a-pricing-tiers-schema", componentType: "PricingTiers", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/schema.json", sha256: "2142bcda2811d488baca3c2b2775e81caf10494d445fd641f472d879fe0360ed" },
  "m1-e-a-pricing-tiers-variants": { artifactId: "m1-e-a-pricing-tiers-variants", componentType: "PricingTiers", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/variants.json", sha256: "25c90e9af173d8769ddcb08b351e7787963125dc6d9a167d8910796b3fd0e4c9", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-pricing-tiers-content-budget": { artifactId: "m1-e-a-pricing-tiers-content-budget", componentType: "PricingTiers", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/content-budget.json", sha256: "48145c3610c754f80e7a15d96bd01d1c6be8b79fda0ad3a5203858ed3b3e78ca" },
  "m1-e-a-pricing-tiers-accessibility": { artifactId: "m1-e-a-pricing-tiers-accessibility", componentType: "PricingTiers", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/accessibility.json", sha256: "9074b38ca54b4ff8ae695af1be4a126c8e0fc4ffb227717df782d7877061b5be" },
  "m1-e-a-pricing-tiers-reduced-motion": { artifactId: "m1-e-a-pricing-tiers-reduced-motion", componentType: "PricingTiers", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/reduced-motion.json", sha256: "d97814d1b31706f855c594ca60a1723fd0a633dccaddb4f5144bde34aa4bef91" },
  "m1-e-a-pricing-tiers-fixtures": { artifactId: "m1-e-a-pricing-tiers-fixtures", componentType: "PricingTiers", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/fixtures.json", sha256: "aa3a82e750135eb16244cc50ced531f5c9696d0b37f8bfe45e78c325506de51c", fixtureIds: ["m1-e-a-pricing-tiers"], fixtureFiles: [{ fixtureId: "m1-e-a-pricing-tiers", repositoryPath: "apps/site-renderer/fixtures/component-qualification/pricing-tiers-spec.json", sha256: "55e56c9470f431dce847723b3f88ed363f1bae63217ebe34ee60ec4fa144164d" }] },
  "m1-e-a-pricing-tiers-visual-regression": { artifactId: "m1-e-a-pricing-tiers-visual-regression", componentType: "PricingTiers", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/PricingTiers/visual-regression.json", sha256: "38d54f68fe6775031df27f653a896478c18e30eaba8cce8544b860f7ea291b89", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/PricingTiers.png", sha256: "2fb11231a2d90b0fc57edf3fec8d173d8ff2f7b12a56b9846c05a1006c237764" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/PricingTiers.png", sha256: "73860d42eb2d460dc0cb54e95c1e5144833cd2ea82d6c8a2729e7f82bbb829f8" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/PricingTiers.png", sha256: "589b4e458178b007655ef3ab9ee358c6aabb84d78f8da5093ac164c7b289dd2b" }] },
  "m1-e-a-value-strip-schema": { artifactId: "m1-e-a-value-strip-schema", componentType: "ValueStrip", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/schema.json", sha256: "defde0eb57904f0554d891fc28e1fa89900881156b3b37abe156b1aeeab652a9" },
  "m1-e-a-value-strip-variants": { artifactId: "m1-e-a-value-strip-variants", componentType: "ValueStrip", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/variants.json", sha256: "cee952385969a0adb4d48b5436898a55527c5b1a5ad4057a19e54f5ea15c8ed1", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-value-strip-content-budget": { artifactId: "m1-e-a-value-strip-content-budget", componentType: "ValueStrip", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/content-budget.json", sha256: "c936540d1580338896da002e0331980a7154911fd063e7c5ba3daf895347f9c6" },
  "m1-e-a-value-strip-accessibility": { artifactId: "m1-e-a-value-strip-accessibility", componentType: "ValueStrip", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/accessibility.json", sha256: "2aa22c8c647050aef1555a09d65c2b22c37100ca34620818cd2b686d90c1ce92" },
  "m1-e-a-value-strip-reduced-motion": { artifactId: "m1-e-a-value-strip-reduced-motion", componentType: "ValueStrip", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/reduced-motion.json", sha256: "0b9756ddb25d87e9cdd0213f594f40334050adf0f3f37621cbb27308e22ad53b" },
  "m1-e-a-value-strip-fixtures": { artifactId: "m1-e-a-value-strip-fixtures", componentType: "ValueStrip", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/fixtures.json", sha256: "a2b879818925c9c4e5d22a23b46132072dcc5e070844d3cd3fd7f95fa3d7f484", fixtureIds: ["m1-e-a-value-strip"], fixtureFiles: [{ fixtureId: "m1-e-a-value-strip", repositoryPath: "apps/site-renderer/fixtures/component-qualification/value-strip-spec.json", sha256: "b2abc8c854f26012951ac1a4780f866132aac8f1ba83eff08ea496c810d2c5ca" }] },
  "m1-e-a-value-strip-visual-regression": { artifactId: "m1-e-a-value-strip-visual-regression", componentType: "ValueStrip", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ValueStrip/visual-regression.json", sha256: "22a982099b86851a8e1ee3d93f3aa94ea52a72e4d0a8fccd16388ada505b2eb0", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ValueStrip.png", sha256: "25dec464f22445b8881655e596ddf51da431bf405e55ec6c5e922764365cf006" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ValueStrip.png", sha256: "6562919a89f8d51da3a1eb0a791e64ba36e8d4663d0c8fb763885003ee48b6eb" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ValueStrip.png", sha256: "e29d98309b65b0035db316f5399e8a5b091c32aaff6e19b20fe306556d25a4b2" }] },
  "m1-e-a-area-marquee-schema": { artifactId: "m1-e-a-area-marquee-schema", componentType: "AreaMarquee", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/schema.json", sha256: "fe0eed4cdee8d8fb5cf10f386db7dbeb356b90723bf6efaacedc2332df54642f" },
  "m1-e-a-area-marquee-variants": { artifactId: "m1-e-a-area-marquee-variants", componentType: "AreaMarquee", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/variants.json", sha256: "857aea271928fb231bd1e66315f93dcb534f67a50d07b85f8244a6dd94813263", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-area-marquee-content-budget": { artifactId: "m1-e-a-area-marquee-content-budget", componentType: "AreaMarquee", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/content-budget.json", sha256: "f627a7b99959bfc4b3542d9028b33166104255ebbdb3b0aa74ca65561d7ff426" },
  "m1-e-a-area-marquee-accessibility": { artifactId: "m1-e-a-area-marquee-accessibility", componentType: "AreaMarquee", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/accessibility.json", sha256: "f79656153ac242ead4ab31afb32ea8c825e602ca35b3acc36cb16f5f2b3c8437" },
  "m1-e-a-area-marquee-reduced-motion": { artifactId: "m1-e-a-area-marquee-reduced-motion", componentType: "AreaMarquee", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/reduced-motion.json", sha256: "c2b8af5ca2cb0ac1b1dc502148a8a54808d8d6ead80979b946e4e6e8d8c836d4" },
  "m1-e-a-area-marquee-fixtures": { artifactId: "m1-e-a-area-marquee-fixtures", componentType: "AreaMarquee", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/fixtures.json", sha256: "aa5e88f5f7e1b1dea042a4f9146bf3385707c03cd276f5895061f33b880d0a15", fixtureIds: ["m1-e-a-area-marquee"], fixtureFiles: [{ fixtureId: "m1-e-a-area-marquee", repositoryPath: "apps/site-renderer/fixtures/component-qualification/area-marquee-spec.json", sha256: "bc71d8577068cd23a3046bdf0199fdba7b12916ec203431580ae4d50c9849ecd" }] },
  "m1-e-a-area-marquee-visual-regression": { artifactId: "m1-e-a-area-marquee-visual-regression", componentType: "AreaMarquee", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/AreaMarquee/visual-regression.json", sha256: "e49f8c108a9263a7b508416683d8aaa37ac386ee7f5cd88716499bc7a5a577a5", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/AreaMarquee.png", sha256: "dc83be436262a264f06baf5d9472feb966e35fbd3c0895c373c8a5615659c75e" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/AreaMarquee.png", sha256: "010140fe10efbd95411405b281176a6d5bc796f65c714d4bb5e6864027c43334" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/AreaMarquee.png", sha256: "cb7abd1b3913316c55a93b23073ff39d1e08476ef3841c594e1f199269840e0c" }] },
  "m1-e-a-faq-split-schema": { artifactId: "m1-e-a-faq-split-schema", componentType: "FaqSplit", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/schema.json", sha256: "a8224d247dff7af264ac2b54d72f698c9a8270b989be475823b22245ba79ef73" },
  "m1-e-a-faq-split-variants": { artifactId: "m1-e-a-faq-split-variants", componentType: "FaqSplit", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/variants.json", sha256: "846233297e365bdec496032dd5d7eb8123400de5d7ec5e8c7d0ddadd4886eb2b", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-faq-split-content-budget": { artifactId: "m1-e-a-faq-split-content-budget", componentType: "FaqSplit", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/content-budget.json", sha256: "ae871ea84f65e1bd36df2cc607dea01c97fe72d7222ee182990d3ab74540fa03" },
  "m1-e-a-faq-split-accessibility": { artifactId: "m1-e-a-faq-split-accessibility", componentType: "FaqSplit", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/accessibility.json", sha256: "d21a5f85ed59d6ec30bfe434bf1a0ddb18ff03ebc94314e084a5260fc1610a3c" },
  "m1-e-a-faq-split-reduced-motion": { artifactId: "m1-e-a-faq-split-reduced-motion", componentType: "FaqSplit", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/reduced-motion.json", sha256: "abd2e79f30e16ee7fa087292c92d37cac763c91422fd59b0c4fe40591c3d3020" },
  "m1-e-a-faq-split-fixtures": { artifactId: "m1-e-a-faq-split-fixtures", componentType: "FaqSplit", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/fixtures.json", sha256: "7d41f88db492a1f1981a20e1825f0bfef659a3b82091382cdf5315f34810a139", fixtureIds: ["m1-e-a-faq-split"], fixtureFiles: [{ fixtureId: "m1-e-a-faq-split", repositoryPath: "apps/site-renderer/fixtures/component-qualification/faq-split-spec.json", sha256: "2cc909e3eec80652c88a0d95dad5358f11f2140fe92744566a3f7a118a55bbae" }] },
  "m1-e-a-faq-split-visual-regression": { artifactId: "m1-e-a-faq-split-visual-regression", componentType: "FaqSplit", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqSplit/visual-regression.json", sha256: "3e3207a2715b8197a040f4f4cb0e0a1b58d315a1ac2d27e2d3c25fc06f576865", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/FaqSplit.png", sha256: "a1e59c669c7e1ad9969fc827a6b6a47d3226454545625b0edd8358eea9717556" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/FaqSplit.png", sha256: "dc36cc3316463f67b6eb2ac6ac537c401d96951bcac92784e561ab470600d2bb" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/FaqSplit.png", sha256: "f8ccf0253eaa1b8a926c93e6a2a1f34d744cfb09b70c108cd201e78e8f788859" }] },
  "m1-e-a-cta-center-schema": { artifactId: "m1-e-a-cta-center-schema", componentType: "CtaCenter", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/schema.json", sha256: "daeda8da413822f16ba7ce11b0817206681764c8d5f7d2d9f74d3533476e06ea" },
  "m1-e-a-cta-center-variants": { artifactId: "m1-e-a-cta-center-variants", componentType: "CtaCenter", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/variants.json", sha256: "5cb1f673ea1fed65a962b69a1105b9870ee292c057091dabfa4599aab63bd651", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-cta-center-content-budget": { artifactId: "m1-e-a-cta-center-content-budget", componentType: "CtaCenter", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/content-budget.json", sha256: "5fcc9a38c0558aab6eb6ff18eae43818b109d3df7b1c91e77ddb84d06022e78d" },
  "m1-e-a-cta-center-accessibility": { artifactId: "m1-e-a-cta-center-accessibility", componentType: "CtaCenter", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/accessibility.json", sha256: "aa51a6f562f3f1c8975e3b8064e74747ec4464c9e7d722d5458c99a1f611edab" },
  "m1-e-a-cta-center-reduced-motion": { artifactId: "m1-e-a-cta-center-reduced-motion", componentType: "CtaCenter", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/reduced-motion.json", sha256: "6b2463a743d7af1c59bb93a6fda1edd0eec6a21e4033441703b7a02a491b18d6" },
  "m1-e-a-cta-center-fixtures": { artifactId: "m1-e-a-cta-center-fixtures", componentType: "CtaCenter", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/fixtures.json", sha256: "ad5dfddde7ea052e026f9380039d2ef453cd1a056aaf83796ccd7531860214fd", fixtureIds: ["m1-e-a-cta-center"], fixtureFiles: [{ fixtureId: "m1-e-a-cta-center", repositoryPath: "apps/site-renderer/fixtures/component-qualification/cta-center-spec.json", sha256: "0d934b001191ab659d1a47baf5d010dfbde19074a716b42871beefc011e7a482" }] },
  "m1-e-a-cta-center-visual-regression": { artifactId: "m1-e-a-cta-center-visual-regression", componentType: "CtaCenter", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/CtaCenter/visual-regression.json", sha256: "fad649d4191d39ab96b9d6bd2018df4d180e9a576a3a49b5c44bed19b04c7620", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CtaCenter.png", sha256: "de1a96aae10f8407029f2ae7e3615cffea5117c2084430bb6cbd1f2cf7bb3582" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CtaCenter.png", sha256: "b8a615c8876d9a0ff2eb425b1f596866a29a8087685ec1a113a06d8f5a051b41" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CtaCenter.png", sha256: "e8853502e8f6bfe92266870a75a19a2d6ad3f87e942f4ff8eaaa05b3a8c1e51f" }] },
  "m1-e-a-services-dark-schema": { artifactId: "m1-e-a-services-dark-schema", componentType: "ServicesDark", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/schema.json", sha256: "f5cee47f4bb8f0b1de4ae474732881240b073d916930f3183d8c6cc5a0e97e56" },
  "m1-e-a-services-dark-variants": { artifactId: "m1-e-a-services-dark-variants", componentType: "ServicesDark", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/variants.json", sha256: "fbef7cc4e3401bea6999c8458cc2a7a4d9101fdb70ec4b3f6bcb321a975a1a0a", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-services-dark-content-budget": { artifactId: "m1-e-a-services-dark-content-budget", componentType: "ServicesDark", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/content-budget.json", sha256: "0c35c500324ec19c8202a378ffb7cc6ec31a1910fd4aad61b4803b5359a698dc" },
  "m1-e-a-services-dark-accessibility": { artifactId: "m1-e-a-services-dark-accessibility", componentType: "ServicesDark", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/accessibility.json", sha256: "d4a020dcc8e792dabd01b48619810634f26de2777b9e35177beb0e77e5a717f6" },
  "m1-e-a-services-dark-reduced-motion": { artifactId: "m1-e-a-services-dark-reduced-motion", componentType: "ServicesDark", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/reduced-motion.json", sha256: "ce51050160ee781cf9c6164357682252e684f907a164374deb84002663fe5144" },
  "m1-e-a-services-dark-fixtures": { artifactId: "m1-e-a-services-dark-fixtures", componentType: "ServicesDark", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/fixtures.json", sha256: "6ae367e28db0a1f6c4220ddabbb23a98d472475e1afbcaf640781c963109a3f3", fixtureIds: ["m1-e-a-services-dark"], fixtureFiles: [{ fixtureId: "m1-e-a-services-dark", repositoryPath: "apps/site-renderer/fixtures/component-qualification/services-dark-spec.json", sha256: "df5277e2a7fd22cf9c89479885234e5425f9e34813d25387b3bf4f4d3ff85c69" }] },
  "m1-e-a-services-dark-visual-regression": { artifactId: "m1-e-a-services-dark-visual-regression", componentType: "ServicesDark", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ServicesDark/visual-regression.json", sha256: "b9ad878a864316aa77557d9da802b6e948ff8454b09255a9dc5e8e748b5870c0", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ServicesDark.png", sha256: "f641f5ac81599e04bbf3b69edebbfb90588c8bba034e51954177a421634e095c" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ServicesDark.png", sha256: "b8bb21d07af16404c9a4ed813dbf9edb46a35b48c3996eac85a6f2fdc0466e16" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ServicesDark.png", sha256: "579d2f2f1e0e25339772e2eddae1c7fc58cea39f7331e518c12adca9f2d46322" }] },
  "m1-e-a-service-rows-schema": { artifactId: "m1-e-a-service-rows-schema", componentType: "ServiceRows", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/schema.json", sha256: "8667514e7aa31187c270949a14e15944513761f9e793873ad22e9ac54bf26698" },
  "m1-e-a-service-rows-variants": { artifactId: "m1-e-a-service-rows-variants", componentType: "ServiceRows", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/variants.json", sha256: "9e12291d3867c8e4e23a94c7d074d26adfb4500ee7d80687e09fb49e49583e8a", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-service-rows-content-budget": { artifactId: "m1-e-a-service-rows-content-budget", componentType: "ServiceRows", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/content-budget.json", sha256: "e18a179499def0fe7126bd4eee68a88167b7e34ba24122fe66d039b40f345c1b" },
  "m1-e-a-service-rows-accessibility": { artifactId: "m1-e-a-service-rows-accessibility", componentType: "ServiceRows", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/accessibility.json", sha256: "8cf261c6f58bfe4b027f2e2b5d7ea2ef5e73d2cdb39c9b3d189cafdea94984ab" },
  "m1-e-a-service-rows-reduced-motion": { artifactId: "m1-e-a-service-rows-reduced-motion", componentType: "ServiceRows", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/reduced-motion.json", sha256: "31d1647379d9cb779fabd0d7c0bb0360bb879e3c46cab59220ccb8f92fd315f1" },
  "m1-e-a-service-rows-fixtures": { artifactId: "m1-e-a-service-rows-fixtures", componentType: "ServiceRows", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/fixtures.json", sha256: "f6cc81e4a170ed9a00fa97ca53d3c81a6430feb7c43b8fb617949f119d82ea2c", fixtureIds: ["m1-e-a-service-rows"], fixtureFiles: [{ fixtureId: "m1-e-a-service-rows", repositoryPath: "apps/site-renderer/fixtures/component-qualification/service-rows-spec.json", sha256: "dff888a79c43512f1f44ca29c9cd0371cb6df4d4b24bbb5d0ef0e0009bba7c81" }] },
  "m1-e-a-service-rows-visual-regression": { artifactId: "m1-e-a-service-rows-visual-regression", componentType: "ServiceRows", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ServiceRows/visual-regression.json", sha256: "e8fd43f41513acaa951a5f1eb5b1ba3342debcf2e513faf0b0095312df01e619", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ServiceRows.png", sha256: "1183c4ac322571fefb8019985e087884428439faebb37f64f79c9bb19facd698" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ServiceRows.png", sha256: "f0d2e989a43082834c9452be2ff6776a86be574f6cd583f67e095022b277b351" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ServiceRows.png", sha256: "0977a5d9974779ac9be8836b4d83f05b3512479a14c5f0983f8bf4cf16a2077c" }] },
  "m1-e-a-area-gallery-schema": { artifactId:"m1-e-a-area-gallery-schema",componentType:"AreaGallery",part:"schema",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/schema.json",sha256:"f6d88a6f3ecc521e14eafe7b0e0dde83f41a993a0790dd9a7dd1128955222433" },
  "m1-e-a-area-gallery-variants": { artifactId:"m1-e-a-area-gallery-variants",componentType:"AreaGallery",part:"variants",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/variants.json",sha256:"9ea00839ad4ad3a30f22a0702a618bb2cf40bf2d503c9e041b6159f951529fc0",variantValues:["technical-grid","quiet"] },
  "m1-e-a-area-gallery-content-budget": { artifactId:"m1-e-a-area-gallery-content-budget",componentType:"AreaGallery",part:"contentBudget",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/content-budget.json",sha256:"1b6c8d25de9658a5c61184e489f2d2847f856cc0e1858e1066ecb2e4ec057413" },
  "m1-e-a-area-gallery-accessibility": { artifactId:"m1-e-a-area-gallery-accessibility",componentType:"AreaGallery",part:"accessibility",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/accessibility.json",sha256:"d219d08250bc613f78e2702e7470ca6e99368b624d5dd090f00ff04e0947ca0e" },
  "m1-e-a-area-gallery-reduced-motion": { artifactId:"m1-e-a-area-gallery-reduced-motion",componentType:"AreaGallery",part:"reducedMotion",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/reduced-motion.json",sha256:"cf322d9882020740c179dddacee798d4844fb08e40f1718ced88eb7bc181c9f8" },
  "m1-e-a-area-gallery-fixtures": { artifactId:"m1-e-a-area-gallery-fixtures",componentType:"AreaGallery",part:"fixtures",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/fixtures.json",sha256:"63fcca43ea96f8ecd785c82a35099d495b65ad2a1fe013f6143440bed7c55a35",fixtureIds:["m1-e-a-area-gallery"],fixtureFiles:[{fixtureId:"m1-e-a-area-gallery",repositoryPath:"apps/site-renderer/fixtures/component-qualification/area-gallery-spec.json",sha256:"58080dc30d969344d129d64f9761847dca020283d046b76c0fcf41958c38c357"}] },
  "m1-e-a-area-gallery-visual-regression": { artifactId:"m1-e-a-area-gallery-visual-regression",componentType:"AreaGallery",part:"visualRegression",repositoryPath:"docs/evidence/site-builder/component-qualification/AreaGallery/visual-regression.json",sha256:"7ffcfc7adad485c5a331a78734345ece3467dc96ef4e5d101bea4434f1cab321",breakpoints:[375,768,1440],outputs:[{breakpoint:375,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/AreaGallery.png",sha256:"0f1898eb39e4c164da9c6bb3f5bcc1c2e3f1c578dff08a37a9ed377b3a6e20f6"},{breakpoint:768,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/AreaGallery.png",sha256:"356a758b56b94cc44343ebc5165d767fae9fec9917730ab3e4be76a6757d2c35"},{breakpoint:1440,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/AreaGallery.png",sha256:"8816015dd63ac4aa0f873e2daeeee90fdd47a41e269765ba16b013899d5dbe76"}] },
  "m1-e-a-projects-grid-schema": { artifactId:"m1-e-a-projects-grid-schema",componentType:"ProjectsGrid",part:"schema",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/schema.json",sha256:"353126d3c3db9cb80676ae4466c7ec3298e60abbb26c4ae8034a14010ccf8078" },
  "m1-e-a-projects-grid-variants": { artifactId:"m1-e-a-projects-grid-variants",componentType:"ProjectsGrid",part:"variants",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/variants.json",sha256:"3574e5e75d5173cdf71d56a4c9d88cb90043cc46587bf5667c1b2ea0fb4b208b",variantValues:["technical-grid","quiet"] },
  "m1-e-a-projects-grid-content-budget": { artifactId:"m1-e-a-projects-grid-content-budget",componentType:"ProjectsGrid",part:"contentBudget",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/content-budget.json",sha256:"8999c1aea0b8f4b6205e36c12c1c754bc2caaf9380fface08ef218fc1b9391da" },
  "m1-e-a-projects-grid-accessibility": { artifactId:"m1-e-a-projects-grid-accessibility",componentType:"ProjectsGrid",part:"accessibility",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/accessibility.json",sha256:"4b3c97edd9a82125da7ef93db2d6fa724ff0a261cbbc3c277cce1a37a3a72f58" },
  "m1-e-a-projects-grid-reduced-motion": { artifactId:"m1-e-a-projects-grid-reduced-motion",componentType:"ProjectsGrid",part:"reducedMotion",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/reduced-motion.json",sha256:"b36618c988ca2b9cf5b3934539fff2ac0554350012907a8f1a4529ff9eaf3c40" },
  "m1-e-a-projects-grid-fixtures": { artifactId:"m1-e-a-projects-grid-fixtures",componentType:"ProjectsGrid",part:"fixtures",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/fixtures.json",sha256:"a6945a20cbd87f9013ccabc8bf9ec26f831d2c791b0ac10ab18cde71d4fc99b2",fixtureIds:["m1-e-a-projects-grid"],fixtureFiles:[{fixtureId:"m1-e-a-projects-grid",repositoryPath:"apps/site-renderer/fixtures/component-qualification/projects-grid-spec.json",sha256:"f86b13fd1a7ec311b2a92b2760211ab6ec0a6f6e660a276272f40ea41d4c9e2b"}] },
  "m1-e-a-projects-grid-visual-regression": { artifactId:"m1-e-a-projects-grid-visual-regression",componentType:"ProjectsGrid",part:"visualRegression",repositoryPath:"docs/evidence/site-builder/component-qualification/ProjectsGrid/visual-regression.json",sha256:"8ca5549fc8a9d05b4f0baf6e42f2f357a3a5a0eed902fc64c9fb0bd638fe8a87",breakpoints:[375,768,1440],outputs:[{breakpoint:375,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProjectsGrid.png",sha256:"77974f9d92fe69a04496bb692fc59c3780be49ec5a5ec1f48b4a48e002e7173f"},{breakpoint:768,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProjectsGrid.png",sha256:"daf328cbd93541ae949d248391b88807f21afc2fbe6443f28971f7342efaf95f"},{breakpoint:1440,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProjectsGrid.png",sha256:"e2801bf5ce471ff114f89e0759bee5edcc24f986c7c41042b00c11d0795357c1"}] },
  "m1-e-a-materials-library-schema": { artifactId:"m1-e-a-materials-library-schema",componentType:"MaterialsLibrary",part:"schema",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/schema.json",sha256:"e4f5ee2b36fb9f29114af385d11b46fa5b226013fdf9488b0efcd953a7f55212" },
  "m1-e-a-materials-library-variants": { artifactId:"m1-e-a-materials-library-variants",componentType:"MaterialsLibrary",part:"variants",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/variants.json",sha256:"4ac99f0e92bc9ccc5bd53ebde7caa9c9fb5c0a59c4aa01b4df4731ca3c95aa59",variantValues:["technical-grid","quiet"] },
  "m1-e-a-materials-library-content-budget": { artifactId:"m1-e-a-materials-library-content-budget",componentType:"MaterialsLibrary",part:"contentBudget",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/content-budget.json",sha256:"40ce0dcccab1b56de0afed43551912e73af3d8d2d592e7cd2d3e4c5a9e4016f9" },
  "m1-e-a-materials-library-accessibility": { artifactId:"m1-e-a-materials-library-accessibility",componentType:"MaterialsLibrary",part:"accessibility",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/accessibility.json",sha256:"fb16ed4f73750358ae669c602b7f35b9cb87949f292a430fea6ae6ddf65744ad" },
  "m1-e-a-materials-library-reduced-motion": { artifactId:"m1-e-a-materials-library-reduced-motion",componentType:"MaterialsLibrary",part:"reducedMotion",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/reduced-motion.json",sha256:"08bf6b56850aecc70d1d0d15c72132a6184ea2ede45b72a6dcb7eb4836e0fd7b" },
  "m1-e-a-materials-library-fixtures": { artifactId:"m1-e-a-materials-library-fixtures",componentType:"MaterialsLibrary",part:"fixtures",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/fixtures.json",sha256:"1473476cdb9f3c1abb2eaee32a7838e3d582f09b7fb64407780b8c0ac52ec0c1",fixtureIds:["m1-e-a-materials-library"],fixtureFiles:[{fixtureId:"m1-e-a-materials-library",repositoryPath:"apps/site-renderer/fixtures/component-qualification/materials-library-spec.json",sha256:"e1e8f4a485e3afe90bc6b551c1282397f0424cdc57303ccb85d48e1ca700a81e"}] },
  "m1-e-a-materials-library-visual-regression": { artifactId:"m1-e-a-materials-library-visual-regression",componentType:"MaterialsLibrary",part:"visualRegression",repositoryPath:"docs/evidence/site-builder/component-qualification/MaterialsLibrary/visual-regression.json",sha256:"19ad95d03dbbe0431c6faa5b88240021e363e3f490ced284b3ecb3426f9c0efe",breakpoints:[375,768,1440],outputs:[{breakpoint:375,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/MaterialsLibrary.png",sha256:"4ce84aa4704fe38988cad863a5ef65417168d0ae02eda4e102e7266cf415f0b4"},{breakpoint:768,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/MaterialsLibrary.png",sha256:"f4692a7a3f1ef1a8297a26fba0cd056d56a3c41ca53d96116263621125e5b7cf"},{breakpoint:1440,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/MaterialsLibrary.png",sha256:"5621ec8d4f6f183a0cde9b44599cc5074b80a6e5f41b68fcd1e51fafe12d0091"}] },
  "m1-e-a-collection-cards-schema": { artifactId:"m1-e-a-collection-cards-schema",componentType:"CollectionCards",part:"schema",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/schema.json",sha256:"fd2b19dbb64fb95b26c39c272cb0a9983d37058b8309f6558b4e9407b0b0b0b7" },
  "m1-e-a-collection-cards-variants": { artifactId:"m1-e-a-collection-cards-variants",componentType:"CollectionCards",part:"variants",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/variants.json",sha256:"b5abc7b0b01155922340e87103421b4e92cb24d2199b5d248854677bdcc26dd7",variantValues:["technical-grid","quiet"] },
  "m1-e-a-collection-cards-content-budget": { artifactId:"m1-e-a-collection-cards-content-budget",componentType:"CollectionCards",part:"contentBudget",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/content-budget.json",sha256:"061fb97da0f9a0f8087cd67204565b321a9d3f690c48c54fc73eaade0d618475" },
  "m1-e-a-collection-cards-accessibility": { artifactId:"m1-e-a-collection-cards-accessibility",componentType:"CollectionCards",part:"accessibility",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/accessibility.json",sha256:"8bb324c916ed162b6c72bf2caded1128d6af2b8f352770671714210eeda36453" },
  "m1-e-a-collection-cards-reduced-motion": { artifactId:"m1-e-a-collection-cards-reduced-motion",componentType:"CollectionCards",part:"reducedMotion",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/reduced-motion.json",sha256:"aac3dbcfd0cf75596de53dd13144d97adef9cf16d7e0b90755fe0b81d0783cdd" },
  "m1-e-a-collection-cards-fixtures": { artifactId:"m1-e-a-collection-cards-fixtures",componentType:"CollectionCards",part:"fixtures",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/fixtures.json",sha256:"ca5983b93b5a5dc89991bccd9aedf66f324dcb68c7f33cbd1ec03c8823c83668",fixtureIds:["m1-e-a-collection-cards"],fixtureFiles:[{fixtureId:"m1-e-a-collection-cards",repositoryPath:"apps/site-renderer/fixtures/component-qualification/collection-cards-spec.json",sha256:"bcc12e112851bc32d3a9a26b5df151565de6276e150ae4dce978340094df44c6"}] },
  "m1-e-a-collection-cards-visual-regression": { artifactId:"m1-e-a-collection-cards-visual-regression",componentType:"CollectionCards",part:"visualRegression",repositoryPath:"docs/evidence/site-builder/component-qualification/CollectionCards/visual-regression.json",sha256:"307c79ba88e66d5cc7b8a59625678c855bb1ccff0dbe2a7da2e0e1c713185923",breakpoints:[375,768,1440],outputs:[{breakpoint:375,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CollectionCards.png",sha256:"660b4572abbe93416956971391b8ccc52fb3f8236424d043ef90d3d12ea8c613"},{breakpoint:768,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CollectionCards.png",sha256:"2601a0525dbb6fc39a33ff0f4ef4522e8b0883510a29aaf4398d2d516c1d533f"},{breakpoint:1440,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CollectionCards.png",sha256:"c55763f171e8b06709137b31e44c756210d7457542dd27a56f6d3cce23029f99"}] },
  "m1-e-a-product-showcase-alt-schema": { artifactId:"m1-e-a-product-showcase-alt-schema",componentType:"ProductShowcaseAlt",part:"schema",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/schema.json",sha256:"441d5754aa139fedb20c232ae305d0fc356f8619675fb6e71ca39ff2c81b1646" },
  "m1-e-a-product-showcase-alt-variants": { artifactId:"m1-e-a-product-showcase-alt-variants",componentType:"ProductShowcaseAlt",part:"variants",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/variants.json",sha256:"bc41e93db8f385fa982685d1e0547360a81eadba4e9994cc88cb25b4c9f0062f",variantValues:["technical-grid","quiet"] },
  "m1-e-a-product-showcase-alt-content-budget": { artifactId:"m1-e-a-product-showcase-alt-content-budget",componentType:"ProductShowcaseAlt",part:"contentBudget",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/content-budget.json",sha256:"1e2ddfb001d9c09025525170576e63518c2ff8ef2f88dfcbb69afafecf27f2e7" },
  "m1-e-a-product-showcase-alt-accessibility": { artifactId:"m1-e-a-product-showcase-alt-accessibility",componentType:"ProductShowcaseAlt",part:"accessibility",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/accessibility.json",sha256:"e9a79878d0cb6edbb8f34997d017c8a8252ba4cbe45ccc7b305f113c01936bbf" },
  "m1-e-a-product-showcase-alt-reduced-motion": { artifactId:"m1-e-a-product-showcase-alt-reduced-motion",componentType:"ProductShowcaseAlt",part:"reducedMotion",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/reduced-motion.json",sha256:"8db51395308bab03e553896dbd75c5cffb35374c1ac29cf8958aefd4858bae78" },
  "m1-e-a-product-showcase-alt-fixtures": { artifactId:"m1-e-a-product-showcase-alt-fixtures",componentType:"ProductShowcaseAlt",part:"fixtures",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/fixtures.json",sha256:"41a3b8b39fe92e055c67c7a2f6b526002043e03d3c4d8768e796434d4e090486",fixtureIds:["m1-e-a-product-showcase-alt"],fixtureFiles:[{fixtureId:"m1-e-a-product-showcase-alt",repositoryPath:"apps/site-renderer/fixtures/component-qualification/product-showcase-alt-spec.json",sha256:"2801026f16f1c06e44094e6f3e904d1ccdd1f5e94d3c715224320d4317bd2633"}] },
  "m1-e-a-product-showcase-alt-visual-regression": { artifactId:"m1-e-a-product-showcase-alt-visual-regression",componentType:"ProductShowcaseAlt",part:"visualRegression",repositoryPath:"docs/evidence/site-builder/component-qualification/ProductShowcaseAlt/visual-regression.json",sha256:"06e91b1a9cc73253c41e50c9e6854cfe5f9269861c724a70962e35592ec480c8",breakpoints:[375,768,1440],outputs:[{breakpoint:375,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProductShowcaseAlt.png",sha256:"9444ea0102653b5a6627fed8b09e55639de6b4309dbaa1b6972fb9550d1fcd50"},{breakpoint:768,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProductShowcaseAlt.png",sha256:"ee707e551081b1d0c3844fb1e6c8335bce1fd6da1e1cea5c9d55a935c9996551"},{breakpoint:1440,repositoryPath:"apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProductShowcaseAlt.png",sha256:"78910ee5a21af876074a6c6085e592581ba719e608dded7f6192e41c5d35d6e1"}] },
  ...Object.fromEntries(["EditorialHero","SplitAbout","WarmHero","DishesShowcase","PhotoGallery"].flatMap((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    const path = `docs/evidence/site-builder/component-qualification/${componentType}`;
    const fixturePath = `apps/site-renderer/fixtures/component-qualification/${slug}-spec.json`;
    const visualPath = (breakpoint: string) => `apps/site-renderer/visual-tests/__screenshots__/qualification/${breakpoint}/${componentType}.png`;
    const sha256 = A10_SHA256[componentType as keyof typeof A10_SHA256];
    return [
      [`${prefix}-schema`, { artifactId: `${prefix}-schema`, componentType, part: "schema", repositoryPath: `${path}/schema.json`, sha256: sha256.schema }],
      [`${prefix}-variants`, { artifactId: `${prefix}-variants`, componentType, part: "variants", repositoryPath: `${path}/variants.json`, sha256: sha256.variants, variantValues: ["technical-grid", "quiet"] }],
      [`${prefix}-content-budget`, { artifactId: `${prefix}-content-budget`, componentType, part: "contentBudget", repositoryPath: `${path}/content-budget.json`, sha256: sha256.contentBudget }],
      [`${prefix}-accessibility`, { artifactId: `${prefix}-accessibility`, componentType, part: "accessibility", repositoryPath: `${path}/accessibility.json`, sha256: sha256.accessibility }],
      [`${prefix}-reduced-motion`, { artifactId: `${prefix}-reduced-motion`, componentType, part: "reducedMotion", repositoryPath: `${path}/reduced-motion.json`, sha256: sha256.reducedMotion }],
      [`${prefix}-fixtures`, { artifactId: `${prefix}-fixtures`, componentType, part: "fixtures", repositoryPath: `${path}/fixtures.json`, sha256: sha256.fixtures, fixtureIds: [prefix], fixtureFiles: [{ fixtureId: prefix, repositoryPath: fixturePath, sha256: sha256.fixture }] }],
      [`${prefix}-visual-regression`, { artifactId: `${prefix}-visual-regression`, componentType, part: "visualRegression", repositoryPath: `${path}/visual-regression.json`, sha256: sha256.visualRegression, breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: visualPath("mobile-375"), sha256: sha256.mobile }, { breakpoint: 768, repositoryPath: visualPath("tablet-768"), sha256: sha256.tablet }, { breakpoint: 1440, repositoryPath: visualPath("desktop-1440"), sha256: sha256.desktop }] }],
    ];
  })) as Record<string, ComponentQualificationArtifact>,
  ...Object.fromEntries(["MediaCta", "FarmhouseHero", "FeaturedSpotlight", "StoryChapters", "ChapterShowcase"].flatMap((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    const path = `docs/evidence/site-builder/component-qualification/${componentType}`;
    const fixturePath = `apps/site-renderer/fixtures/component-qualification/${slug}-spec.json`;
    const visualPath = (breakpoint: string) => `apps/site-renderer/visual-tests/__screenshots__/qualification/${breakpoint}/${componentType}.png`;
    const sha256 = A11_SHA256[componentType as keyof typeof A11_SHA256];
    return [
      [`${prefix}-schema`, { artifactId: `${prefix}-schema`, componentType, part: "schema", repositoryPath: `${path}/schema.json`, sha256: sha256.schema }],
      [`${prefix}-variants`, { artifactId: `${prefix}-variants`, componentType, part: "variants", repositoryPath: `${path}/variants.json`, sha256: sha256.variants, variantValues: ["technical-grid", "quiet"] }],
      [`${prefix}-content-budget`, { artifactId: `${prefix}-content-budget`, componentType, part: "contentBudget", repositoryPath: `${path}/content-budget.json`, sha256: sha256.contentBudget }],
      [`${prefix}-accessibility`, { artifactId: `${prefix}-accessibility`, componentType, part: "accessibility", repositoryPath: `${path}/accessibility.json`, sha256: sha256.accessibility }],
      [`${prefix}-reduced-motion`, { artifactId: `${prefix}-reduced-motion`, componentType, part: "reducedMotion", repositoryPath: `${path}/reduced-motion.json`, sha256: sha256.reducedMotion }],
      [`${prefix}-fixtures`, { artifactId: `${prefix}-fixtures`, componentType, part: "fixtures", repositoryPath: `${path}/fixtures.json`, sha256: sha256.fixtures, fixtureIds: [prefix], fixtureFiles: [{ fixtureId: prefix, repositoryPath: fixturePath, sha256: sha256.fixture }] }],
      [`${prefix}-visual-regression`, { artifactId: `${prefix}-visual-regression`, componentType, part: "visualRegression", repositoryPath: `${path}/visual-regression.json`, sha256: sha256.visualRegression, breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: visualPath("mobile-375"), sha256: sha256.mobile }, { breakpoint: 768, repositoryPath: visualPath("tablet-768"), sha256: sha256.tablet }, { breakpoint: 1440, repositoryPath: visualPath("desktop-1440"), sha256: sha256.desktop }] }],
    ];
  })) as Record<string, ComponentQualificationArtifact>,
  ...Object.fromEntries(["DispatchHero", "ServicesEditorial", "DispatchTimeline", "CrewGrid", "CoverageMap"].flatMap((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    const path = `docs/evidence/site-builder/component-qualification/${componentType}`;
    const fixturePath = `apps/site-renderer/fixtures/component-qualification/${slug}-spec.json`;
    const visualPath = (breakpoint: string) => `apps/site-renderer/visual-tests/__screenshots__/qualification/${breakpoint}/${componentType}.png`;
    const sha256 = A12_SHA256[componentType as keyof typeof A12_SHA256];
    return [
      [`${prefix}-schema`, { artifactId: `${prefix}-schema`, componentType, part: "schema", repositoryPath: `${path}/schema.json`, sha256: sha256.schema }],
      [`${prefix}-variants`, { artifactId: `${prefix}-variants`, componentType, part: "variants", repositoryPath: `${path}/variants.json`, sha256: sha256.variants, variantValues: ["technical-grid", "quiet"] }],
      [`${prefix}-content-budget`, { artifactId: `${prefix}-content-budget`, componentType, part: "contentBudget", repositoryPath: `${path}/content-budget.json`, sha256: sha256.contentBudget }],
      [`${prefix}-accessibility`, { artifactId: `${prefix}-accessibility`, componentType, part: "accessibility", repositoryPath: `${path}/accessibility.json`, sha256: sha256.accessibility }],
      [`${prefix}-reduced-motion`, { artifactId: `${prefix}-reduced-motion`, componentType, part: "reducedMotion", repositoryPath: `${path}/reduced-motion.json`, sha256: sha256.reducedMotion }],
      [`${prefix}-fixtures`, { artifactId: `${prefix}-fixtures`, componentType, part: "fixtures", repositoryPath: `${path}/fixtures.json`, sha256: sha256.fixtures, fixtureIds: [prefix], fixtureFiles: [{ fixtureId: prefix, repositoryPath: fixturePath, sha256: sha256.fixture }] }],
      [`${prefix}-visual-regression`, { artifactId: `${prefix}-visual-regression`, componentType, part: "visualRegression", repositoryPath: `${path}/visual-regression.json`, sha256: sha256.visualRegression, breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: visualPath("mobile-375"), sha256: sha256.mobile }, { breakpoint: 768, repositoryPath: visualPath("tablet-768"), sha256: sha256.tablet }, { breakpoint: 1440, repositoryPath: visualPath("desktop-1440"), sha256: sha256.desktop }] }],
    ];
  })) as Record<string, ComponentQualificationArtifact>,
  ...Object.fromEntries(["HeroFull", "AxiomHero", "ColorwayPicker", "SaaSHero", "IndustrialHero", "MinimalHero"].flatMap((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    const path = `docs/evidence/site-builder/component-qualification/${componentType}`;
    const fixturePath = `apps/site-renderer/fixtures/component-qualification/${slug}-spec.json`;
    const sha256 = A13_SHA256[componentType as keyof typeof A13_SHA256];
    const visualPath = (breakpoint: string) => `apps/site-renderer/visual-tests/__screenshots__/qualification/${breakpoint}/${componentType}.png`;
    return [
      [`${prefix}-schema`, { artifactId: `${prefix}-schema`, componentType, part: "schema", repositoryPath: `${path}/schema.json`, sha256: sha256.schema }],
      [`${prefix}-variants`, { artifactId: `${prefix}-variants`, componentType, part: "variants", repositoryPath: `${path}/variants.json`, sha256: sha256.variants, variantValues: ["technical-grid", "quiet"] }],
      [`${prefix}-content-budget`, { artifactId: `${prefix}-content-budget`, componentType, part: "contentBudget", repositoryPath: `${path}/content-budget.json`, sha256: sha256.contentBudget }],
      [`${prefix}-accessibility`, { artifactId: `${prefix}-accessibility`, componentType, part: "accessibility", repositoryPath: `${path}/accessibility.json`, sha256: sha256.accessibility }],
      [`${prefix}-reduced-motion`, { artifactId: `${prefix}-reduced-motion`, componentType, part: "reducedMotion", repositoryPath: `${path}/reduced-motion.json`, sha256: sha256.reducedMotion }],
      [`${prefix}-fixtures`, { artifactId: `${prefix}-fixtures`, componentType, part: "fixtures", repositoryPath: `${path}/fixtures.json`, sha256: sha256.fixtures, fixtureIds: [prefix], fixtureFiles: [{ fixtureId: prefix, repositoryPath: fixturePath, sha256: sha256.fixture }] }],
      [`${prefix}-visual-regression`, { artifactId: `${prefix}-visual-regression`, componentType, part: "visualRegression", repositoryPath: `${path}/visual-regression.json`, sha256: sha256.visualRegression, breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: visualPath("mobile-375"), sha256: sha256.mobile }, { breakpoint: 768, repositoryPath: visualPath("tablet-768"), sha256: sha256.tablet }, { breakpoint: 1440, repositoryPath: visualPath("desktop-1440"), sha256: sha256.desktop }] }],
    ];
  })) as Record<string, ComponentQualificationArtifact>,
} satisfies Record<string, ComponentQualificationArtifact>);

/**
 * Only components with real evidence for all seven M1-e-A parts belong here.
 * The registry starts empty: gallery extraction and legacy release eligibility
 * are not qualification evidence.
 */
export const M1_E_A_COMPONENT_QUALIFICATIONS: Readonly<
  Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
> = Object.freeze({
  CtaBanner: {
    schema: { artifactId: "m1-e-a-cta-banner-schema" },
    variants: { artifactId: "m1-e-a-cta-banner-variants" },
    contentBudget: { artifactId: "m1-e-a-cta-banner-content-budget" },
    accessibility: { artifactId: "m1-e-a-cta-banner-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-cta-banner-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-cta-banner-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-cta-banner-visual-regression",
    },
  },
  HeroBanner: {
    schema: { artifactId: "m1-e-a-hero-banner-schema" },
    variants: { artifactId: "m1-e-a-hero-banner-variants" },
    contentBudget: { artifactId: "m1-e-a-hero-banner-content-budget" },
    accessibility: { artifactId: "m1-e-a-hero-banner-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-hero-banner-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-hero-banner-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-hero-banner-visual-regression",
    },
  },
  StatsBand: {
    schema: { artifactId: "m1-e-a-stats-band-schema" },
    variants: { artifactId: "m1-e-a-stats-band-variants" },
    contentBudget: { artifactId: "m1-e-a-stats-band-content-budget" },
    accessibility: { artifactId: "m1-e-a-stats-band-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-stats-band-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-stats-band-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-stats-band-visual-regression",
    },
  },
  ProductGrid: {
    schema: { artifactId: "m1-e-a-product-grid-schema" },
    variants: { artifactId: "m1-e-a-product-grid-variants" },
    contentBudget: { artifactId: "m1-e-a-product-grid-content-budget" },
    accessibility: { artifactId: "m1-e-a-product-grid-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-product-grid-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-product-grid-fixtures" },
    visualRegression: { artifactId: "m1-e-a-product-grid-visual-regression" },
  },
  AboutBlock: {
    schema: { artifactId: "m1-e-a-about-block-schema" },
    variants: { artifactId: "m1-e-a-about-block-variants" },
    contentBudget: { artifactId: "m1-e-a-about-block-content-budget" },
    accessibility: { artifactId: "m1-e-a-about-block-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-about-block-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-about-block-fixtures" },
    visualRegression: { artifactId: "m1-e-a-about-block-visual-regression" },
  },
  InquiryForm: {
    schema: { artifactId: "m1-e-a-inquiry-form-schema" },
    variants: { artifactId: "m1-e-a-inquiry-form-variants" },
    contentBudget: { artifactId: "m1-e-a-inquiry-form-content-budget" },
    accessibility: { artifactId: "m1-e-a-inquiry-form-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-inquiry-form-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-inquiry-form-fixtures" },
    visualRegression: { artifactId: "m1-e-a-inquiry-form-visual-regression" },
  },
  CertWall: {
    schema: { artifactId: "m1-e-a-cert-wall-schema" },
    variants: { artifactId: "m1-e-a-cert-wall-variants" },
    contentBudget: { artifactId: "m1-e-a-cert-wall-content-budget" },
    accessibility: { artifactId: "m1-e-a-cert-wall-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-cert-wall-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-cert-wall-fixtures" },
    visualRegression: { artifactId: "m1-e-a-cert-wall-visual-regression" },
  },
  ProcessTimeline: {
    schema: { artifactId: "m1-e-a-process-timeline-schema" },
    variants: { artifactId: "m1-e-a-process-timeline-variants" },
    contentBudget: { artifactId: "m1-e-a-process-timeline-content-budget" },
    accessibility: { artifactId: "m1-e-a-process-timeline-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-process-timeline-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-process-timeline-fixtures" },
    visualRegression: { artifactId: "m1-e-a-process-timeline-visual-regression" },
  },
  FaqAccordion: {
    schema: { artifactId: "m1-e-a-faq-accordion-schema" },
    variants: { artifactId: "m1-e-a-faq-accordion-variants" },
    contentBudget: { artifactId: "m1-e-a-faq-accordion-content-budget" },
    accessibility: { artifactId: "m1-e-a-faq-accordion-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-faq-accordion-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-faq-accordion-fixtures" },
    visualRegression: { artifactId: "m1-e-a-faq-accordion-visual-regression" },
  },
  LogoMarquee: {
    schema: { artifactId: "m1-e-a-logo-marquee-schema" }, variants: { artifactId: "m1-e-a-logo-marquee-variants" }, contentBudget: { artifactId: "m1-e-a-logo-marquee-content-budget" }, accessibility: { artifactId: "m1-e-a-logo-marquee-accessibility" }, reducedMotion: { artifactId: "m1-e-a-logo-marquee-reduced-motion" }, fixtures: { artifactId: "m1-e-a-logo-marquee-fixtures" }, visualRegression: { artifactId: "m1-e-a-logo-marquee-visual-regression" },
  },
  MapLocation: {
    schema: { artifactId: "m1-e-a-map-location-schema" }, variants: { artifactId: "m1-e-a-map-location-variants" }, contentBudget: { artifactId: "m1-e-a-map-location-content-budget" }, accessibility: { artifactId: "m1-e-a-map-location-accessibility" }, reducedMotion: { artifactId: "m1-e-a-map-location-reduced-motion" }, fixtures: { artifactId: "m1-e-a-map-location-fixtures" }, visualRegression: { artifactId: "m1-e-a-map-location-visual-regression" },
  },
  Testimonials: {
    schema: { artifactId: "m1-e-a-testimonials-schema" }, variants: { artifactId: "m1-e-a-testimonials-variants" }, contentBudget: { artifactId: "m1-e-a-testimonials-content-budget" }, accessibility: { artifactId: "m1-e-a-testimonials-accessibility" }, reducedMotion: { artifactId: "m1-e-a-testimonials-reduced-motion" }, fixtures: { artifactId: "m1-e-a-testimonials-fixtures" }, visualRegression: { artifactId: "m1-e-a-testimonials-visual-regression" },
  },
  FeatureCards: {
    schema: { artifactId: "m1-e-a-feature-cards-schema" }, variants: { artifactId: "m1-e-a-feature-cards-variants" }, contentBudget: { artifactId: "m1-e-a-feature-cards-content-budget" }, accessibility: { artifactId: "m1-e-a-feature-cards-accessibility" }, reducedMotion: { artifactId: "m1-e-a-feature-cards-reduced-motion" }, fixtures: { artifactId: "m1-e-a-feature-cards-fixtures" }, visualRegression: { artifactId: "m1-e-a-feature-cards-visual-regression" },
  },
  TechSystems: {
    schema: { artifactId: "m1-e-a-tech-systems-schema" }, variants: { artifactId: "m1-e-a-tech-systems-variants" }, contentBudget: { artifactId: "m1-e-a-tech-systems-content-budget" }, accessibility: { artifactId: "m1-e-a-tech-systems-accessibility" }, reducedMotion: { artifactId: "m1-e-a-tech-systems-reduced-motion" }, fixtures: { artifactId: "m1-e-a-tech-systems-fixtures" }, visualRegression: { artifactId: "m1-e-a-tech-systems-visual-regression" },
  },
  ServicesGrid: {
    schema: { artifactId: "m1-e-a-services-grid-schema" }, variants: { artifactId: "m1-e-a-services-grid-variants" }, contentBudget: { artifactId: "m1-e-a-services-grid-content-budget" }, accessibility: { artifactId: "m1-e-a-services-grid-accessibility" }, reducedMotion: { artifactId: "m1-e-a-services-grid-reduced-motion" }, fixtures: { artifactId: "m1-e-a-services-grid-fixtures" }, visualRegression: { artifactId: "m1-e-a-services-grid-visual-regression" },
  },
  TrustSplit: {
    schema: { artifactId: "m1-e-a-trust-split-schema" }, variants: { artifactId: "m1-e-a-trust-split-variants" }, contentBudget: { artifactId: "m1-e-a-trust-split-content-budget" }, accessibility: { artifactId: "m1-e-a-trust-split-accessibility" }, reducedMotion: { artifactId: "m1-e-a-trust-split-reduced-motion" }, fixtures: { artifactId: "m1-e-a-trust-split-fixtures" }, visualRegression: { artifactId: "m1-e-a-trust-split-visual-regression" },
  },
  ProcessSteps: {
    schema: { artifactId: "m1-e-a-process-steps-schema" }, variants: { artifactId: "m1-e-a-process-steps-variants" }, contentBudget: { artifactId: "m1-e-a-process-steps-content-budget" }, accessibility: { artifactId: "m1-e-a-process-steps-accessibility" }, reducedMotion: { artifactId: "m1-e-a-process-steps-reduced-motion" }, fixtures: { artifactId: "m1-e-a-process-steps-fixtures" }, visualRegression: { artifactId: "m1-e-a-process-steps-visual-regression" },
  },
  ArticleGrid: {
    schema: { artifactId: "m1-e-a-article-grid-schema" }, variants: { artifactId: "m1-e-a-article-grid-variants" }, contentBudget: { artifactId: "m1-e-a-article-grid-content-budget" }, accessibility: { artifactId: "m1-e-a-article-grid-accessibility" }, reducedMotion: { artifactId: "m1-e-a-article-grid-reduced-motion" }, fixtures: { artifactId: "m1-e-a-article-grid-fixtures" }, visualRegression: { artifactId: "m1-e-a-article-grid-visual-regression" },
  },
  StatementBlock: {
    schema: { artifactId: "m1-e-a-statement-block-schema" }, variants: { artifactId: "m1-e-a-statement-block-variants" }, contentBudget: { artifactId: "m1-e-a-statement-block-content-budget" }, accessibility: { artifactId: "m1-e-a-statement-block-accessibility" }, reducedMotion: { artifactId: "m1-e-a-statement-block-reduced-motion" }, fixtures: { artifactId: "m1-e-a-statement-block-fixtures" }, visualRegression: { artifactId: "m1-e-a-statement-block-visual-regression" },
  },
  PricingTable: {
    schema: { artifactId: "m1-e-a-pricing-table-schema" }, variants: { artifactId: "m1-e-a-pricing-table-variants" }, contentBudget: { artifactId: "m1-e-a-pricing-table-content-budget" }, accessibility: { artifactId: "m1-e-a-pricing-table-accessibility" }, reducedMotion: { artifactId: "m1-e-a-pricing-table-reduced-motion" }, fixtures: { artifactId: "m1-e-a-pricing-table-fixtures" }, visualRegression: { artifactId: "m1-e-a-pricing-table-visual-regression" },
  },
  StatsCountup: {
    schema: { artifactId: "m1-e-a-stats-countup-schema" }, variants: { artifactId: "m1-e-a-stats-countup-variants" }, contentBudget: { artifactId: "m1-e-a-stats-countup-content-budget" }, accessibility: { artifactId: "m1-e-a-stats-countup-accessibility" }, reducedMotion: { artifactId: "m1-e-a-stats-countup-reduced-motion" }, fixtures: { artifactId: "m1-e-a-stats-countup-fixtures" }, visualRegression: { artifactId: "m1-e-a-stats-countup-visual-regression" },
  },
  LedgerStats: {
    schema: { artifactId: "m1-e-a-ledger-stats-schema" }, variants: { artifactId: "m1-e-a-ledger-stats-variants" }, contentBudget: { artifactId: "m1-e-a-ledger-stats-content-budget" }, accessibility: { artifactId: "m1-e-a-ledger-stats-accessibility" }, reducedMotion: { artifactId: "m1-e-a-ledger-stats-reduced-motion" }, fixtures: { artifactId: "m1-e-a-ledger-stats-fixtures" }, visualRegression: { artifactId: "m1-e-a-ledger-stats-visual-regression" },
  },
  PricingTiers: {
    schema: { artifactId: "m1-e-a-pricing-tiers-schema" }, variants: { artifactId: "m1-e-a-pricing-tiers-variants" }, contentBudget: { artifactId: "m1-e-a-pricing-tiers-content-budget" }, accessibility: { artifactId: "m1-e-a-pricing-tiers-accessibility" }, reducedMotion: { artifactId: "m1-e-a-pricing-tiers-reduced-motion" }, fixtures: { artifactId: "m1-e-a-pricing-tiers-fixtures" }, visualRegression: { artifactId: "m1-e-a-pricing-tiers-visual-regression" },
  },
  ValueStrip: {
   schema: { artifactId: "m1-e-a-value-strip-schema" }, variants: { artifactId: "m1-e-a-value-strip-variants" }, contentBudget: { artifactId: "m1-e-a-value-strip-content-budget" }, accessibility: { artifactId: "m1-e-a-value-strip-accessibility" }, reducedMotion: { artifactId: "m1-e-a-value-strip-reduced-motion" }, fixtures: { artifactId: "m1-e-a-value-strip-fixtures" }, visualRegression: { artifactId: "m1-e-a-value-strip-visual-regression" },
 },
  AreaMarquee: {
    schema: { artifactId: "m1-e-a-area-marquee-schema" }, variants: { artifactId: "m1-e-a-area-marquee-variants" }, contentBudget: { artifactId: "m1-e-a-area-marquee-content-budget" }, accessibility: { artifactId: "m1-e-a-area-marquee-accessibility" }, reducedMotion: { artifactId: "m1-e-a-area-marquee-reduced-motion" }, fixtures: { artifactId: "m1-e-a-area-marquee-fixtures" }, visualRegression: { artifactId: "m1-e-a-area-marquee-visual-regression" },
  },
  FaqSplit: {
    schema: { artifactId: "m1-e-a-faq-split-schema" }, variants: { artifactId: "m1-e-a-faq-split-variants" }, contentBudget: { artifactId: "m1-e-a-faq-split-content-budget" }, accessibility: { artifactId: "m1-e-a-faq-split-accessibility" }, reducedMotion: { artifactId: "m1-e-a-faq-split-reduced-motion" }, fixtures: { artifactId: "m1-e-a-faq-split-fixtures" }, visualRegression: { artifactId: "m1-e-a-faq-split-visual-regression" },
  },
  CtaCenter: {
    schema: { artifactId: "m1-e-a-cta-center-schema" }, variants: { artifactId: "m1-e-a-cta-center-variants" }, contentBudget: { artifactId: "m1-e-a-cta-center-content-budget" }, accessibility: { artifactId: "m1-e-a-cta-center-accessibility" }, reducedMotion: { artifactId: "m1-e-a-cta-center-reduced-motion" }, fixtures: { artifactId: "m1-e-a-cta-center-fixtures" }, visualRegression: { artifactId: "m1-e-a-cta-center-visual-regression" },
  },
  ServicesDark: {
    schema: { artifactId: "m1-e-a-services-dark-schema" }, variants: { artifactId: "m1-e-a-services-dark-variants" }, contentBudget: { artifactId: "m1-e-a-services-dark-content-budget" }, accessibility: { artifactId: "m1-e-a-services-dark-accessibility" }, reducedMotion: { artifactId: "m1-e-a-services-dark-reduced-motion" }, fixtures: { artifactId: "m1-e-a-services-dark-fixtures" }, visualRegression: { artifactId: "m1-e-a-services-dark-visual-regression" },
  },
  ServiceRows: {
    schema: { artifactId: "m1-e-a-service-rows-schema" }, variants: { artifactId: "m1-e-a-service-rows-variants" }, contentBudget: { artifactId: "m1-e-a-service-rows-content-budget" }, accessibility: { artifactId: "m1-e-a-service-rows-accessibility" }, reducedMotion: { artifactId: "m1-e-a-service-rows-reduced-motion" }, fixtures: { artifactId: "m1-e-a-service-rows-fixtures" }, visualRegression: { artifactId: "m1-e-a-service-rows-visual-regression" },
  },
  AreaGallery: {
    schema: { artifactId: "m1-e-a-area-gallery-schema" }, variants: { artifactId: "m1-e-a-area-gallery-variants" }, contentBudget: { artifactId: "m1-e-a-area-gallery-content-budget" }, accessibility: { artifactId: "m1-e-a-area-gallery-accessibility" }, reducedMotion: { artifactId: "m1-e-a-area-gallery-reduced-motion" }, fixtures: { artifactId: "m1-e-a-area-gallery-fixtures" }, visualRegression: { artifactId: "m1-e-a-area-gallery-visual-regression" },
  },
  ProjectsGrid: {
    schema: { artifactId: "m1-e-a-projects-grid-schema" }, variants: { artifactId: "m1-e-a-projects-grid-variants" }, contentBudget: { artifactId: "m1-e-a-projects-grid-content-budget" }, accessibility: { artifactId: "m1-e-a-projects-grid-accessibility" }, reducedMotion: { artifactId: "m1-e-a-projects-grid-reduced-motion" }, fixtures: { artifactId: "m1-e-a-projects-grid-fixtures" }, visualRegression: { artifactId: "m1-e-a-projects-grid-visual-regression" },
  },
  MaterialsLibrary: {
    schema: { artifactId: "m1-e-a-materials-library-schema" }, variants: { artifactId: "m1-e-a-materials-library-variants" }, contentBudget: { artifactId: "m1-e-a-materials-library-content-budget" }, accessibility: { artifactId: "m1-e-a-materials-library-accessibility" }, reducedMotion: { artifactId: "m1-e-a-materials-library-reduced-motion" }, fixtures: { artifactId: "m1-e-a-materials-library-fixtures" }, visualRegression: { artifactId: "m1-e-a-materials-library-visual-regression" },
  },
  CollectionCards: {
    schema: { artifactId: "m1-e-a-collection-cards-schema" }, variants: { artifactId: "m1-e-a-collection-cards-variants" }, contentBudget: { artifactId: "m1-e-a-collection-cards-content-budget" }, accessibility: { artifactId: "m1-e-a-collection-cards-accessibility" }, reducedMotion: { artifactId: "m1-e-a-collection-cards-reduced-motion" }, fixtures: { artifactId: "m1-e-a-collection-cards-fixtures" }, visualRegression: { artifactId: "m1-e-a-collection-cards-visual-regression" },
  },
  ProductShowcaseAlt: {
    schema: { artifactId: "m1-e-a-product-showcase-alt-schema" }, variants: { artifactId: "m1-e-a-product-showcase-alt-variants" }, contentBudget: { artifactId: "m1-e-a-product-showcase-alt-content-budget" }, accessibility: { artifactId: "m1-e-a-product-showcase-alt-accessibility" }, reducedMotion: { artifactId: "m1-e-a-product-showcase-alt-reduced-motion" }, fixtures: { artifactId: "m1-e-a-product-showcase-alt-fixtures" }, visualRegression: { artifactId: "m1-e-a-product-showcase-alt-visual-regression" },
  },
  ...Object.fromEntries(["EditorialHero", "SplitAbout", "WarmHero", "DishesShowcase", "PhotoGallery"].map((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    return [componentType, { schema: { artifactId: `${prefix}-schema` }, variants: { artifactId: `${prefix}-variants` }, contentBudget: { artifactId: `${prefix}-content-budget` }, accessibility: { artifactId: `${prefix}-accessibility` }, reducedMotion: { artifactId: `${prefix}-reduced-motion` }, fixtures: { artifactId: `${prefix}-fixtures` }, visualRegression: { artifactId: `${prefix}-visual-regression` } }];
  })) as Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>,
  ...Object.fromEntries(["MediaCta", "FarmhouseHero", "FeaturedSpotlight", "StoryChapters", "ChapterShowcase"].map((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    return [componentType, { schema: { artifactId: `${prefix}-schema` }, variants: { artifactId: `${prefix}-variants` }, contentBudget: { artifactId: `${prefix}-content-budget` }, accessibility: { artifactId: `${prefix}-accessibility` }, reducedMotion: { artifactId: `${prefix}-reduced-motion` }, fixtures: { artifactId: `${prefix}-fixtures` }, visualRegression: { artifactId: `${prefix}-visual-regression` } }];
  })) as Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>,
  ...Object.fromEntries(["DispatchHero", "ServicesEditorial", "DispatchTimeline", "CrewGrid", "CoverageMap"].map((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    return [componentType, { schema: { artifactId: `${prefix}-schema` }, variants: { artifactId: `${prefix}-variants` }, contentBudget: { artifactId: `${prefix}-content-budget` }, accessibility: { artifactId: `${prefix}-accessibility` }, reducedMotion: { artifactId: `${prefix}-reduced-motion` }, fixtures: { artifactId: `${prefix}-fixtures` }, visualRegression: { artifactId: `${prefix}-visual-regression` } }];
  })) as Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>,
  ...Object.fromEntries(["HeroFull", "AxiomHero", "ColorwayPicker", "SaaSHero", "IndustrialHero", "MinimalHero"].map((componentType) => {
    const slug = componentType.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const prefix = `m1-e-a-${slug}`;
    return [componentType, { schema: { artifactId: `${prefix}-schema` }, variants: { artifactId: `${prefix}-variants` }, contentBudget: { artifactId: `${prefix}-content-budget` }, accessibility: { artifactId: `${prefix}-accessibility` }, reducedMotion: { artifactId: `${prefix}-reduced-motion` }, fixtures: { artifactId: `${prefix}-fixtures` }, visualRegression: { artifactId: `${prefix}-visual-regression` } }];
  })) as Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>,
});

export interface ReleaseQualificationRegistryInput {
  releaseTypes: readonly string[];
  qualifications: Readonly<
    Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
  >;
  artifacts: Readonly<Record<string, ComponentQualificationArtifact>>;
}

export type ComponentReleaseReadiness =
  | { status: "gallery_only" }
  | { status: "transitional_release" }
  | {
      status: "m1_e_a_qualified";
      evidence: ComponentQualificationEvidence;
    };

function qualificationError(
  type: SiteSpecComponentType,
  detail: string,
): Error {
  return new Error(`COMPONENT_QUALIFICATION_INVALID: ${type} -- ${detail}`);
}

function validateArtifactPath(
  type: SiteSpecComponentType,
  artifact: ComponentQualificationArtifact,
): void {
  const prefix = `docs/evidence/site-builder/component-qualification/${type}/`;
  if (
    !artifact.repositoryPath.startsWith(prefix) ||
    !artifact.repositoryPath.endsWith(".json") ||
    artifact.repositoryPath.includes("..") ||
    artifact.repositoryPath.includes("\\")
  ) {
    throw qualificationError(
      type,
      `${artifact.artifactId}: invalid repositoryPath`,
    );
  }
}

function validateRepositoryBytePath(
  type: SiteSpecComponentType,
  artifactId: string,
  repositoryPath: string,
  prefix: string,
  suffix: string,
): void {
  if (
    !repositoryPath.startsWith(prefix) ||
    !repositoryPath.endsWith(suffix) ||
    repositoryPath.includes("..") ||
    repositoryPath.includes("\\")
  ) {
    throw qualificationError(
      type,
      `${artifactId}: invalid byte repositoryPath`,
    );
  }
}

export function validateComponentQualification(
  type: SiteSpecComponentType,
  evidence: ComponentQualificationEvidence,
  artifacts: Readonly<
    Record<string, ComponentQualificationArtifact>
  > = M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
): ComponentQualificationEvidence {
  const parsed = componentQualificationSchema.safeParse(evidence);
  if (!parsed.success) {
    throw qualificationError(
      type,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }

  const referencedIds = new Set<string>();
  for (const part of COMPONENT_QUALIFICATION_PARTS) {
    const artifactId = parsed.data[part].artifactId;
    if (referencedIds.has(artifactId)) {
      throw qualificationError(
        type,
        `${part}: duplicate artifactId ${artifactId}`,
      );
    }
    referencedIds.add(artifactId);

    const artifact = artifacts[artifactId];
    const parsedArtifact =
      componentQualificationArtifactSchema.safeParse(artifact);
    if (!parsedArtifact.success) {
      throw qualificationError(
        type,
        `${part}: unresolved or invalid ${artifactId}`,
      );
    }
    if (
      parsedArtifact.data.artifactId !== artifactId ||
      parsedArtifact.data.componentType !== type ||
      parsedArtifact.data.part !== part
    ) {
      throw qualificationError(
        type,
        `${part}: mismatched artifact ${artifactId}`,
      );
    }
    validateArtifactPath(type, parsedArtifact.data);

    if (
      parsedArtifact.data.part === "variants" &&
      new Set(parsedArtifact.data.variantValues).size !==
        parsedArtifact.data.variantValues.length
    ) {
      throw qualificationError(type, `${part}: variant values must be unique`);
    }
    if (
      parsedArtifact.data.part === "fixtures" &&
      new Set(parsedArtifact.data.fixtureIds).size !==
        parsedArtifact.data.fixtureIds.length
    ) {
      throw qualificationError(type, `${part}: fixture ids must be unique`);
    }
    if (parsedArtifact.data.part === "fixtures") {
      const fixtureArtifact = parsedArtifact.data;
      const fileIds = fixtureArtifact.fixtureFiles.map(
        ({ fixtureId }) => fixtureId,
      );
      if (
        fileIds.length !== fixtureArtifact.fixtureIds.length ||
        fileIds.some(
          (fixtureId, index) => fixtureId !== fixtureArtifact.fixtureIds[index],
        )
      ) {
        throw qualificationError(
          type,
          `${part}: fixture files must match fixture ids`,
        );
      }
      for (const fixture of fixtureArtifact.fixtureFiles) {
        validateRepositoryBytePath(
          type,
          fixtureArtifact.artifactId,
          fixture.repositoryPath,
          "apps/site-renderer/fixtures/",
          ".json",
        );
      }
    }
    if (parsedArtifact.data.part === "visualRegression") {
      const visualArtifact = parsedArtifact.data;
      const breakpointDirectories = {
        375: "mobile-375",
        768: "tablet-768",
        1440: "desktop-1440",
      } as const;
      for (const output of visualArtifact.outputs) {
        const expectedPath =
          "apps/site-renderer/visual-tests/__screenshots__/qualification/" +
          `${breakpointDirectories[output.breakpoint]}/${type}.png`;
        validateRepositoryBytePath(
          type,
          visualArtifact.artifactId,
          output.repositoryPath,
          expectedPath,
          ".png",
        );
        if (output.repositoryPath !== expectedPath) {
          throw qualificationError(
            type,
            `${part}: output path does not match breakpoint`,
          );
        }
      }
    }
  }

  return parsed.data;
}

export function assertReleaseQualificationRegistryIntegrity(
  input: ReleaseQualificationRegistryInput = {
    releaseTypes: SITE_SPEC_RELEASE_COMPONENT_TYPES,
    qualifications: M1_E_A_COMPONENT_QUALIFICATIONS,
    artifacts: M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
  },
): void {
  const componentTypes = new Set<string>(SITE_SPEC_COMPONENT_TYPES);
  const releaseTypes = new Set(input.releaseTypes);
  const transitionalTypes = new Set<string>(
    SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
  );

  for (const type of SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES) {
    if (!releaseTypes.has(type)) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
  }

  for (const type of input.releaseTypes) {
    if (!componentTypes.has(type)) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    if (transitionalTypes.has(type)) continue;
    const evidence = input.qualifications[type as SiteSpecComponentType];
    if (!evidence) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    validateComponentQualification(
      type as SiteSpecComponentType,
      evidence,
      input.artifacts,
    );
  }

  for (const [type, evidence] of Object.entries(input.qualifications)) {
    if (!componentTypes.has(type) || !releaseTypes.has(type) || !evidence) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    validateComponentQualification(
      type as SiteSpecComponentType,
      evidence as ComponentQualificationEvidence,
      input.artifacts,
    );
  }
}

export function getComponentReleaseReadiness(
  type: SiteSpecComponentType,
): ComponentReleaseReadiness {
  const evidence = M1_E_A_COMPONENT_QUALIFICATIONS[type];
  if (evidence) {
    return {
      status: "m1_e_a_qualified",
      evidence: validateComponentQualification(
        type,
        evidence,
        M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
      ),
    };
  }
  if (
    SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES.includes(
      type as (typeof SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES)[number],
    )
  ) {
    return { status: "transitional_release" };
  }
  return { status: "gallery_only" };
}

export function assertReleaseComponentEligible(
  type: SiteSpecComponentType,
): void {
  if (!SITE_SPEC_RELEASE_COMPONENT_TYPES.includes(type as never)) {
    throw new Error(`SITE_RELEASE_COMPONENT_NOT_ELIGIBLE: ${type}`);
  }
  const readiness = getComponentReleaseReadiness(type);
  if (
    readiness.status !== "transitional_release" &&
    readiness.status !== "m1_e_a_qualified"
  ) {
    throw new Error(`SITE_RELEASE_COMPONENT_NOT_ELIGIBLE: ${type}`);
  }
}

assertReleaseQualificationRegistryIntegrity();
