//! Canonical runtime-152 local self-withdrawal prover. All spend secrets stay opaque.
//! The caller separately anchors this public snapshot to the live finalized chain.
use super::*;
use std::collections::{BTreeSet, VecDeque};
use plonky2::{field::types::{Field, PrimeField64}, hash::poseidon2::Poseidon2Hash, plonk::{config::Hasher, proof::ProofWithPublicInputs, circuit_data::{VerifierCircuitData, VerifierOnlyCircuitData}}};
use qp_wormhole_circuit::{inputs::{CircuitInputs, PrivateCircuitInputs, PublicCircuitInputs, PrivateBatchPublicInputs}, sensitive::Secret, block_header::header::HeaderInputs, circuit::circuit_logic::WormholeCircuit};
use qp_wormhole_aggregator::{dummy_proof::{generate_dummy_proof, load_dummy_proof}, private_batch::prover::PrivateBatchProver};
use qp_zk_circuits_common::{circuit::{F,C,D,wormhole_leaf_circuit_config,wormhole_private_batch_circuit_config}, utils::{BytesDigest,u64_to_felts}, serialization::{bytes_to_digest,digest_to_bytes}, zk_merkle::ZkMerkleProof};
use serde::{Deserialize,Serialize};

const GENESIS: &str = "0xfb5487c0be6ae4ade2d41d16e50465129861636c2b8d61fa94d7a19631626fba";
const CODE_HASH: &str = "0x4a2d509dfa3faf06a9645bd444d5f2f63ac8ab2f75ba540a0b84680a514514fa";
const QUANTUM:u128 = 10_000_000_000;
const SLOTS:usize = 7;
const VALIDATION: &str = "Encrypted withdrawal validation failed";
type R<T> = Result<T,&'static str>;
type Proof = ProofWithPublicInputs<F,C,D>;
fn checked<T,E>(r:Result<T,E>)->R<T> { r.map_err(|_| VALIDATION) }
fn require(value:bool)->R<()> { if value { Ok(()) } else { Err(VALIDATION) } }
fn hex(bytes:&[u8])->String { let mut s=String::with_capacity(2+bytes.len()*2); s.push_str("0x"); for b in bytes { use std::fmt::Write; let _=write!(s,"{b:02x}"); } s }
fn unhex(s:&str)->R<Vec<u8>> {
 require(s.starts_with("0x") && s.len()%2==0 && s.len()<=226)?;
 checked(s.as_bytes()[2..].chunks_exact(2).map(|v| {
  let a=(v[0] as char).to_digit(16).ok_or(VALIDATION)?; let b=(v[1] as char).to_digit(16).ok_or(VALIDATION)?; Ok((a*16+b) as u8)
 }).collect::<R<Vec<u8>>>())
}
fn bytes<const N:usize>(s:&str)->R<[u8;N]> { checked(unhex(s)?.try_into()) }
fn digest(s:&str)->R<BytesDigest> { checked(BytesDigest::try_from(bytes::<32>(s)?)) }
fn decimal(s:&str)->R<u128> { require(!s.is_empty() && s.len()<=39 && (s=="0" || !s.starts_with('0')) && s.bytes().all(|b| b.is_ascii_digit()))?; checked(s.parse()) }

#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request { spec_version:u32,genesis_hash:String,code_hash:String,volume_fee_bps:u32,normal_account_index:u32,expected_normal_address:String,expected:Expected,block:Block,inputs:Vec<Input> }
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Expected { input_planck:String,net_planck:String,fee_planck:String }
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Block { hash:String,number:u32,parent_hash:String,state_root:String,extrinsics_root:String,zk_tree_root:String,digest:String }
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Input { branch:u32,index:u32,address:String,transfer_count:String,leaf_index:String,amount_planck:String,leaf_data:String,leaf_hash:String,siblings:Vec<Vec<String>> }
#[derive(Serialize,Clone)] #[serde(rename_all="camelCase")]
struct Summary { real_nullifiers:Vec<String>,normal_address:String,input_planck:String,net_planck:String,fee_planck:String,verified:bool,code_hash:String }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
struct ResultSummary { #[serde(flatten)] summary:Summary,public_inputs:Vec<String> }

impl WormholeSession {
 fn normal_public(&self,index:u32)->R<(String,[u8;32],Vec<u8>,String)> {
  let path=canonical_path("ml-dsa-65",index)?;
  let seed=self.seed.as_ref().ok_or("Encrypted account is locked")?;
  let key=checked(qp_rusty_crystals_hdwallet::ml_dsa_65::derive_key_from_seed(seed,&path))?;
  let public=key.public().to_bytes().to_vec(); let id=qp_poseidon_core::hash_bytes(&public);
  Ok((address_for_id(&id),id,public,path))
 }
 fn prepare_inner(&self,json:&str)->R<WithdrawalJob> {
  require(json.len()<=65536)?;
  let r:Request=checked(serde_json::from_str(json))?;
  require(r.spec_version==SUPPORTED_SPEC && r.genesis_hash==GENESIS && r.code_hash==CODE_HASH && r.volume_fee_bps==4 && (1..=SLOTS).contains(&r.inputs.len()))?;
  let (normal_address,normal_id,_,_)=self.normal_public(r.normal_account_index)?;
  require(normal_address==r.expected_normal_address)?;
  let parent=digest(&r.block.parent_hash)?; let state=digest(&r.block.state_root)?; let extrinsics=digest(&r.block.extrinsics_root)?;let root=bytes::<32>(&r.block.zk_tree_root)?;
  let mut logs=[0u8;110];let d=unhex(&r.block.digest)?;require(!d.is_empty() && d.len()<=110)?;logs[..d.len()].copy_from_slice(&d);
  let block_hash=digest(&r.block.hash)?;
  require(checked(HeaderInputs::new(parent,r.block.number,state,extrinsics,checked(root.try_into())?,&logs))?.block_hash()==block_hash)?;
  let normal_digest=checked(normal_id.try_into())?; let zero=checked([0u8;32].try_into())?;
  let mut inputs=VecDeque::new();let mut real_nullifiers=Vec::new();let mut seen=BTreeSet::new();let mut leaves=BTreeSet::new();let mut raw_total=0u128;let mut scaled_total=0u64;
  for i in r.inputs {
   let pair=self.derive_pair(i.index,i.branch)?;require(i.address==address_for_id(pair.address()))?;
   let tc:u64=checked(decimal(&i.transfer_count)?.try_into())?;let leaf_index:u64=checked(decimal(&i.leaf_index)?.try_into())?;
   require(leaves.insert(leaf_index))?;
   let raw=decimal(&i.amount_planck)?;let scaled:u32=checked((raw/QUANTUM).try_into())?;require(scaled>0)?;
   let ld=bytes::<60>(&i.leaf_data)?;require(ld[..32]==pair.address()[..] && u64::from_le_bytes(checked(ld[32..40].try_into())?)==tc && u32::from_le_bytes(checked(ld[40..44].try_into())?)==0 && u128::from_le_bytes(checked(ld[44..60].try_into())?)==raw)?;
   let leaf=leaf_hash(pair.address(),tc,scaled);require(leaf==bytes::<32>(&i.leaf_hash)?)?;
   require(i.siblings.len()<=16 && leaf_index < (1u64 << (2*i.siblings.len())))?;let siblings=i.siblings.iter().map(|level| {require(level.len()==3)?; Ok([bytes::<32>(&level[0])?,bytes::<32>(&level[1])?,bytes::<32>(&level[2])?])}).collect::<R<Vec<_>>>()?;
   let mp=checked(ZkMerkleProof::from_unsorted(leaf_index,siblings,leaf,root))?;require(mp.verify_with_positions())?;
   let n=wormhole_nullifier(&pair,tc);require(seen.insert(n))?;real_nullifiers.push(hex(&n));
   raw_total=raw_total.checked_add(raw).ok_or(VALIDATION)?;scaled_total=scaled_total.checked_add(scaled as u64).ok_or(VALIDATION)?;require(scaled_total<=u32::MAX as u64)?;
   let mut secret_bytes=Zeroizing::new(*pair.secret().as_bytes());let secret=checked(Secret::new(&mut secret_bytes))?;
   inputs.push_back(CircuitInputs {public:PublicCircuitInputs {asset_id:0,input_amount:scaled,output_amount_1:scaled,output_amount_2:0,volume_fee_bps:4,nullifier:checked(n.try_into())?,exit_account_1:normal_digest,exit_account_2:zero,block_hash,block_number:r.block.number},private:PrivateCircuitInputs {secret,transfer_count:tc,unspendable_account:checked((*pair.address()).try_into())?,parent_hash:parent,state_root:state,extrinsics_root:extrinsics,digest:logs,zk_tree_root:root,zk_merkle_siblings:mp.siblings,zk_merkle_positions:mp.positions}});
  }
  let net_scaled=(scaled_total*9996/10000) as u32;require(net_scaled>0)?;let mut fee=scaled_total-net_scaled as u64;
  // Official batch selection distributes the rounded fee from the last input backwards.
  for input in inputs.iter_mut().rev() {let take=fee.min(input.public.output_amount_1 as u64);input.public.output_amount_1-=take as u32;fee-=take;if input.public.output_amount_1==0 {input.public.exit_account_1=zero;}}
  require(fee==0)?;let net=net_scaled as u128*QUANTUM;let loss=raw_total.checked_sub(net).ok_or(VALIDATION)?;
  require(decimal(&r.expected.input_planck)?==raw_total && decimal(&r.expected.net_planck)?==net && decimal(&r.expected.fee_planck)?==loss)?;
  Ok(WithdrawalJob {inputs,proofs:Vec::new(),summary:Summary {real_nullifiers,normal_address,input_planck:raw_total.to_string(),net_planck:net.to_string(),fee_planck:loss.to_string(),verified:true,code_hash:CODE_HASH.to_string()},normal_id,net_scaled,block_hash,block_number:r.block.number,finished:false})
 }
}
fn leaf_hash(account:&[u8;32],tc:u64,scaled:u32)->[u8;32] {let mut p=bytes_to_digest(account).to_vec();p.extend(u64_to_felts(tc));p.push(F::ZERO);p.push(F::from_canonical_u32(scaled));digest_to_bytes(&Poseidon2Hash::hash_no_pad(&p).elements)}

#[wasm_bindgen]
impl WormholeSession {
 /// Derive only public normal-account information from this same retained seed.
 #[wasm_bindgen(js_name=normalInfo)]
 pub fn normal_info(&self,index:u32)->Result<String,JsError> {
  let (address,id,public,path)=self.normal_public(index).map_err(JsError::new)?;
  serde_json::to_string(&serde_json::json!({"address":address,"accountId":id,"publicKey":public,"path":path,"scheme":"ml-dsa-65"})).map_err(|_| JsError::new(VALIDATION))
 }
 #[wasm_bindgen(js_name=prepareWithdrawal)]
 pub fn prepare_withdrawal(&self,json:&str)->Result<WithdrawalJob,JsError> {self.prepare_inner(json).map_err(JsError::new)}
}
/// Opaque, one-shot validated witness. No secret, witness or leaf-proof accessors.
#[wasm_bindgen]
pub struct WithdrawalJob {inputs:VecDeque<CircuitInputs>,proofs:Vec<Proof>,summary:Summary,normal_id:[u8;32],net_scaled:u32,block_hash:BytesDigest,block_number:u32,finished:bool}
#[wasm_bindgen]
impl WithdrawalJob {
 pub fn summary(&self)->Result<String,JsError> {checked(serde_json::to_string(&self.summary)).map_err(JsError::new)}
 #[wasm_bindgen(js_name=proveNextLeaf)]
 pub fn prove_next_leaf(&mut self)->Result<(),JsError> {self.leaf_inner().map_err(JsError::new)}
 pub fn aggregate(&mut self)->Result<WithdrawalResult,JsError> {self.aggregate_inner().map_err(JsError::new)}
}
impl WithdrawalJob {
 fn leaf_inner(&mut self)->R<()> {require(!self.finished)?;let input=self.inputs.pop_front().ok_or(VALIDATION)?;let proof=checked(checked(qp_wormhole_prover::build_fresh().commit(&input))?.prove())?;self.proofs.push(proof);Ok(())}
 fn validate_pi(&self,pi:&[u64])->R<()> {
  require(pi.len()==162)?;let parsed=checked(PrivateBatchPublicInputs::try_from_u64_slice(pi))?;
  require(parsed.num_exit_slots==14 && parsed.asset_id==0 && parsed.volume_fee_bps==4 && parsed.block_data.block_hash==self.block_hash && parsed.block_data.block_number==self.block_number)?;
  let mut total=0u64;for account in parsed.account_data {if account.summed_output_amount>0 {require(account.exit_account.as_ref()==&self.normal_id)?;} else {require(account.exit_account.as_ref()==&[0u8;32])?;}total+=account.summed_output_amount as u64;}
  require(total==self.net_scaled as u64 && parsed.nullifiers.len()==7)?;
  let set: BTreeSet<String>=parsed.nullifiers.iter().map(|n|hex(n.as_ref())).collect();require(set.len()==7 && self.summary.real_nullifiers.iter().all(|n|set.contains(n)))?;
  Ok(())
 }
 fn aggregate_inner(&mut self)->R<WithdrawalResult> {
  require(!self.finished && self.inputs.is_empty() && !self.proofs.is_empty())?;self.finished=true;
  let circuit=checked(WormholeCircuit::new(wormhole_leaf_circuit_config()))?;let targets=circuit.targets();let data=circuit.build_circuit();
  let dummy=checked(load_dummy_proof(checked(generate_dummy_proof(&data,&targets))?,&data.common))?;let lv=data.verifier_data();
  for p in &self.proofs {checked(lv.verify(p.clone()))?;}
  let ag=checked(PrivateBatchProver::new(wormhole_private_batch_circuit_config(),lv.common,&lv.verifier_only,SLOTS,dummy))?;
  let verifier=VerifierCircuitData {common:ag.circuit_data.common.clone(),verifier_only:VerifierOnlyCircuitData {constants_sigmas_cap:ag.circuit_data.prover_only.constants_sigmas_commitment.merkle_tree.cap.clone(),circuit_digest:ag.circuit_data.prover_only.circuit_digest}};
  // These exact canonical bytes occur in the pinned production runtime WASM.
  let vb=checked(verifier.verifier_only.to_bytes())?;let cb=checked(verifier.common.to_bytes(&plonky2::util::serialization::DefaultGateSerializer))?;
  require(hex(&sha2::Sha256::digest(&vb))=="0x9944fa4106ccdbfd9710834aaff95e04b73ee0ef7f4eccf9fb5c5baf45573ed7" && hex(&sha2::Sha256::digest(&cb))=="0x1e75ff884ae73cd1d3cf49fcf6eea49441f4b4458a7cd42ac6f8e92210246476")?;
  drop(data);
  let proof=checked(ag.aggregate(core::mem::take(&mut self.proofs)))?;
  let pi:Vec<u64>=proof.public_inputs.iter().map(|v|v.to_canonical_u64()).collect();self.validate_pi(&pi)?;
  #[cfg(test)]
  { let mut tampered=proof.clone(); tampered.public_inputs[8]+=F::ONE; require(verifier.verify(tampered).is_err())?; }
  let bytes=proof.to_bytes();
  // Deserialize the exact outgoing bytes, then verify them using only the pinned canonical verifier.
  let reparsed=checked(Proof::from_bytes(bytes.clone(),&verifier.common))?;checked(verifier.verify(reparsed))?;
  let summary=checked(serde_json::to_string(&ResultSummary {summary:self.summary.clone(),public_inputs:pi.into_iter().map(|v|v.to_string()).collect()}))?;
  Ok(WithdrawalResult {bytes,summary})
 }
}
#[wasm_bindgen]
pub struct WithdrawalResult {bytes:Vec<u8>,summary:String}
#[wasm_bindgen]
impl WithdrawalResult {
 #[wasm_bindgen(getter,js_name=proofBytes)] pub fn proof_bytes(&self)->Vec<u8> {self.bytes.clone()}
 pub fn summary(&self)->String {self.summary.clone()}
}

#[cfg(test)]
mod tests {
 use super::*;
 const PHRASE:&str="orchard answer curve patient visual flower maze noise retreat penalty cage small earth domain scan pitch bottom crunch theme club client swap slice raven";
 fn fixture()->(WormholeSession,serde_json::Value) {
  let s=open_wormhole(PHRASE.into()).unwrap();let pair=s.derive_pair(0,0).unwrap();let raw=100*QUANTUM+123;let leaf=leaf_hash(pair.address(),0,100);
  let (normal,_,_,_)=s.normal_public(0).unwrap();let parent=[1u8;32];let state=[2u8;32];let ext=[3u8;32];let header=HeaderInputs::new(parent.try_into().unwrap(),1,state.try_into().unwrap(),ext.try_into().unwrap(),leaf.try_into().unwrap(),&[0u8;110]).unwrap();
  let mut ld=pair.address().to_vec();ld.extend(0u64.to_le_bytes());ld.extend(0u32.to_le_bytes());ld.extend(raw.to_le_bytes());
  let v=serde_json::json!({"specVersion":152,"genesisHash":GENESIS,"codeHash":CODE_HASH,"volumeFeeBps":4,"normalAccountIndex":0,"expectedNormalAddress":normal,"expected":{"inputPlanck":raw.to_string(),"netPlanck":(99*QUANTUM).to_string(),"feePlanck":(QUANTUM+123).to_string()},"block":{"hash":hex(header.block_hash().as_ref()),"number":1,"parentHash":hex(&parent),"stateRoot":hex(&state),"extrinsicsRoot":hex(&ext),"zkTreeRoot":hex(&leaf),"digest":"0x00"},"inputs":[{"branch":0,"index":0,"address":address_for_id(pair.address()),"transferCount":"0","leafIndex":"0","amountPlanck":raw.to_string(),"leafData":hex(&ld),"leafHash":hex(&leaf),"siblings":[]}]});(s,v)
 }
 #[test] fn public_snapshot_validation_and_rejections() {
  let (s,v)=fixture();let job=s.prepare_inner(&v.to_string()).unwrap();assert_eq!(job.summary.net_planck,"990000000000");assert_eq!(job.summary.fee_planck,"10000000123");
  if let Ok(path)=std::env::var("QTC_PUBLIC_FIXTURE_PATH") {std::fs::write(path,serde_json::to_string_pretty(&v).unwrap()).unwrap();}
  for path in ["specVersion","genesisHash","codeHash","volumeFeeBps","expectedNormalAddress","normalAccountIndex"] {let mut bad=v.clone();bad[path]=match path {"specVersion"=>153.into(),"volumeFeeBps"=>5.into(),"normalAccountIndex"=>1.into(),_=>"wrong".into()};assert!(s.prepare_inner(&bad.to_string()).is_err());}
  for field in ["hash","zkTreeRoot","parentHash","digest"] {let mut bad=v.clone();bad["block"][field]="0x01".into();assert!(s.prepare_inner(&bad.to_string()).is_err());}
  for field in ["amountPlanck","transferCount","leafIndex","leafData","leafHash","address"] {let mut bad=v.clone();bad["inputs"][0][field]="1".into();assert!(s.prepare_inner(&bad.to_string()).is_err());}
  let mut bad=v.clone();bad["inputs"].as_array_mut().unwrap().push(v["inputs"][0].clone());assert!(s.prepare_inner(&bad.to_string()).is_err());
  for field in ["inputPlanck","netPlanck","feePlanck"] {let mut bad=v.clone();bad["expected"][field]="0".into();assert!(s.prepare_inner(&bad.to_string()).is_err());}
 }
 #[test] fn complete_public_proof_and_binding() {let (s,v)=fixture();let mut job=s.prepare_inner(&v.to_string()).unwrap();job.leaf_inner().unwrap();let result=job.aggregate_inner().unwrap();let r:serde_json::Value=serde_json::from_str(&result.summary).unwrap();let mut pi:Vec<u64>=r["publicInputs"].as_array().unwrap().iter().map(|v|v.as_str().unwrap().parse().unwrap()).collect();assert_eq!(pi.len(),162);assert!(job.validate_pi(&pi).is_ok());pi[8]+=1;assert!(job.validate_pi(&pi).is_err());assert!(job.aggregate_inner().is_err());assert!(result.bytes.len()>100000);}
 #[test] fn two_input_batch_uses_total_fee_and_merkle_membership() {
  let (session,mut value)=fixture();let pair=session.derive_pair(0,0).unwrap();
  let first=leaf_hash(pair.address(),0,100);let second=leaf_hash(pair.address(),1,100);
  let mut children=[first,second,[0u8;32],[0u8;32]];children.sort();
  let root=qp_zk_circuits_common::zk_merkle::hash_node_presorted(&children).unwrap();
  let header=HeaderInputs::new([1u8;32].try_into().unwrap(),1,[2u8;32].try_into().unwrap(),[3u8;32].try_into().unwrap(),root.try_into().unwrap(),&[0u8;110]).unwrap();
  let mut input2=value["inputs"][0].clone();let mut ld=bytes::<60>(input2["leafData"].as_str().unwrap()).unwrap();ld[32..40].copy_from_slice(&1u64.to_le_bytes());
  input2["leafData"]=hex(&ld).into();input2["transferCount"]="1".into();input2["leafIndex"]="1".into();input2["leafHash"]=hex(&second).into();input2["siblings"]=serde_json::json!([[hex(&first),hex(&[0u8;32]),hex(&[0u8;32])]]);
  value["inputs"][0]["siblings"]=serde_json::json!([[hex(&second),hex(&[0u8;32]),hex(&[0u8;32])]]);value["inputs"].as_array_mut().unwrap().push(input2);
  value["block"]["hash"]=hex(header.block_hash().as_ref()).into();value["block"]["zkTreeRoot"]=hex(&root).into();
  value["expected"]=serde_json::json!({"inputPlanck":(200*QUANTUM+246).to_string(),"netPlanck":(199*QUANTUM).to_string(),"feePlanck":(QUANTUM+246).to_string()});
  let mut job=session.prepare_inner(&value.to_string()).unwrap();assert_eq!(job.inputs[0].public.output_amount_1,100);assert_eq!(job.inputs[1].public.output_amount_1,99);
  job.leaf_inner().unwrap();job.leaf_inner().unwrap();assert!(job.aggregate_inner().is_ok());
 }

}
