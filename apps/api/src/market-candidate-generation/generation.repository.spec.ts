import { describe, expect, it } from 'vitest';
import { generationIntentDigest, generationPrepareRequestHash, type GenerationIntentMaterial } from './generation.repository';
const MATERIAL = {
  "generationId": "66666666-6666-4666-8666-666666666666",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "companyId": "22222222-2222-4222-8222-222222222222",
  "requestedBy": "55555555-5555-4555-8555-555555555555",
  "intentId": "77777777-7777-4777-8777-777777777777",
  "intentSequence": "1",
  "prepareRequestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "inputMaterialDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "basisDescriptors": {
    "schemaVersion": "market-candidate-generation-basis/v1",
    "company": {
      "companyId": "22222222-2222-4222-8222-222222222222",
      "version": 1
    },
    "sources": []
  },
  "contractVersion": "market-candidate-generation-contract/v1",
  "contractDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "promptDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "inputSchemaDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "outputSchemaDigest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "modelPolicyDigest": "1111111111111111111111111111111111111111111111111111111111111111",
  "expectedCurrentSetId": null,
  "expectedCurrentRevision": null
};

describe('generation immutable request/intent identities',()=>{
 it('binds the complete explicit immutable control tuple to an independent literal digest',()=>{
  expect(generationIntentDigest(MATERIAL as GenerationIntentMaterial)).toBe('ca0ad3393ee83d04d9d438e0ddae1674b1f8d7528715015804a30ac175c4489e');
 });
 it.each(['generationId','workspaceId','companyId','requestedBy','intentId','intentSequence','prepareRequestHash','inputMaterialDigest','contractVersion','contractDigest','promptDigest','inputSchemaDigest','outputSchemaDigest','modelPolicyDigest']as const)('changes the identity when immutable %s changes',key=>{
  expect(generationIntentDigest({...MATERIAL,[key]:MATERIAL[key]+'x'}as GenerationIntentMaterial)).not.toBe('ca0ad3393ee83d04d9d438e0ddae1674b1f8d7528715015804a30ac175c4489e');
 });
 it('binds source descriptors and the complete prepared current-set anchor',()=>{
  expect(generationIntentDigest({...MATERIAL,basisDescriptors:{...MATERIAL.basisDescriptors,company:{...MATERIAL.basisDescriptors.company,version:2}}}as GenerationIntentMaterial)).not.toBe('ca0ad3393ee83d04d9d438e0ddae1674b1f8d7528715015804a30ac175c4489e');
  expect(generationIntentDigest({...MATERIAL,expectedCurrentSetId:'88888888-8888-4888-8888-888888888888',expectedCurrentRevision:1}as GenerationIntentMaterial)).not.toBe('ca0ad3393ee83d04d9d438e0ddae1674b1f8d7528715015804a30ac175c4489e');
 });
 it('does not make lifecycle changes, model results or feedback part of an immutable intent digest',()=>{
  const mutable={...MATERIAL,phase:'RESULT_READY',setId:'88888888-8888-4888-8888-888888888888',resultDigest:'9'.repeat(64),updatedAt:'2026-11-21'};
  expect(generationIntentDigest(mutable as GenerationIntentMaterial)).toBe('ca0ad3393ee83d04d9d438e0ddae1674b1f8d7528715015804a30ac175c4489e');
 });
 it('normalizes repeated source UUIDs and preserves omission versus explicit empty selection',()=>{
  const a={intentId:MATERIAL.intentId,offeringIds:['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],claimIds:[]};
  expect(generationPrepareRequestHash({...a,offeringIds:[a.offeringIds[0].toUpperCase(),a.offeringIds[0]]})).toBe(generationPrepareRequestHash(a));
  expect(generationPrepareRequestHash({intentId:MATERIAL.intentId})).not.toBe(generationPrepareRequestHash({intentId:MATERIAL.intentId,offeringIds:[],claimIds:[]}));
  expect(()=>generationPrepareRequestHash({...a,candidates:[]})).toThrow();
 });
});
