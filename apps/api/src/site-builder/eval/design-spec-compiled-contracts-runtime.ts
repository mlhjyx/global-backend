import {
  compiledContractsRuntimeBindingFromArtifacts,
  type CompiledContractArtifactFingerprint,
} from "./compiled-contracts-attestation";

export const DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS = Object.freeze([
  {
    path: "packages/contracts/dist/index.js",
    sha256: "3c32f7bf3d05acbc298abe4fc04c76d7298accffd6ddfeb4c2d5f5bb54f20f17",
  },
  {
    path: "packages/contracts/dist/site-builder/component-content-budget.js",
    sha256: "95fc2edec04702cdbe2533d3664d3f1786e882432b795aece7860de4af3e8627",
  },
  {
    path: "packages/contracts/dist/site-builder/component-qualification.js",
    sha256: "d81d10dd6f4be75d2ae8a609470956e2eb7a110c96c48c453952d8f375ee565f",
  },
  {
    path: "packages/contracts/dist/site-builder/component-schema.js",
    sha256: "64ae8e0a36a03f2f845a76165f0e1d1a8d99142f91be264cc8e093b03b3a5735",
  },
  {
    path: "packages/contracts/dist/site-builder/copy-bundle.js",
    sha256: "39ba541502450e6b525ade99bdd3915abb9077aceddf496e64f1a61250bd436d",
  },
  {
    path: "packages/contracts/dist/site-builder/design-brief.js",
    sha256: "0298f28a0298cdfd87e9182f359061ebd724c4728473f3a36aadd61824e88f5c",
  },
  {
    path: "packages/contracts/dist/site-builder/design-catalog-v2.js",
    sha256: "883a369e3f4e4135886344e2c99147081edcea87bad7fb5b29c7811154cda88c",
  },
  {
    path: "packages/contracts/dist/site-builder/design-catalog.js",
    sha256: "fe9bed2c23ed45a310b78c93097fa85a21545f1fb642eeb41411b436863302e6",
  },
  {
    path: "packages/contracts/dist/site-builder/design-dna.js",
    sha256: "bf25cd9a38995d4fe22ee1cf29fc669b2b7231af935a964424e3eb4c5289aee7",
  },
  {
    path: "packages/contracts/dist/site-builder/design-evaluation.js",
    sha256: "36f938cbb8ca5e5ef30e8785f18640a21fa06d5c28228073557be81c3152f28f",
  },
  {
    path: "packages/contracts/dist/site-builder/design-integrity.js",
    sha256: "6c659b241b2826b2e676c60b718f58717fae2669f074198451cdb6324ce4d159",
  },
  {
    path: "packages/contracts/dist/site-builder/design-observation.js",
    sha256: "03310fbe4f340ad8a4b0fa275995a16c33c43a4433765963512210b8b227d03c",
  },
  {
    path: "packages/contracts/dist/site-builder/design-source.js",
    sha256: "929c1d19d1acb07bb99a4a96b8487b97c618774c091ac9b436f97f4c9090d50a",
  },
  {
    path: "packages/contracts/dist/site-builder/evidence.js",
    sha256: "0eb35545a5945fbd896c14fd443a17686fe64dcc27df503980838a34c1410b95",
  },
  {
    path: "packages/contracts/dist/site-builder/inquiry.js",
    sha256: "ec682fba61dc1dbb3b77cd5296d014d690ec239e7001c72f5f14390779e36c6e",
  },
  {
    path: "packages/contracts/dist/site-builder/locales.js",
    sha256: "321fcef1663389f3b943e80b4398f36682353074941dc374432711a6a5a293e5",
  },
  {
    path: "packages/contracts/dist/site-builder/media-foundation.js",
    sha256: "12a6ec13dcf95f7a51af95329e03c09e782e8bfe81f6088db23ece36e54764a2",
  },
  {
    path: "packages/contracts/dist/site-builder/model-policy.js",
    sha256: "b8791a8654b56e8cd52fcd71a28dd8b5d9dee9a78bc9a3caca0e6ea53367ae86",
  },
  {
    path: "packages/contracts/dist/site-builder/site-spec-validation.js",
    sha256: "2111af64d074281ccd8584edf9ec56cf5fdb59d623e64eb48177804079cdaccf",
  },
  {
    path: "packages/contracts/dist/site-builder/site-spec.js",
    sha256: "d8ccbd0b58c44fbf4eb0cf3dc0c094a64cb08934b7c9a330e1f05e217d0e6f9e",
  },
  {
    path: "packages/contracts/dist/site-builder/template-family.js",
    sha256: "75304e7d05f30a5f207473be539e49a98088213297c59f899b18d6ba92320f59",
  },
] as const satisfies readonly CompiledContractArtifactFingerprint[]);

export const DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING = Object.freeze(
  compiledContractsRuntimeBindingFromArtifacts(
    DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS,
  ),
);
