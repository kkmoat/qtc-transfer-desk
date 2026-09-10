//! Circuit data specific to the prover and the verifier.
//!
//! This module also defines a [`CircuitConfig`] to be customized
//! when building circuits for arbitrary statements.
//!
//! After building a circuit, one obtains an instance of [`CircuitData`].
//! This contains both prover and verifier data, allowing to generate
//! proofs for the given circuit and verify them.
//!
//! Most of the [`CircuitData`] is actually prover-specific, and can be
//! extracted by calling [`CircuitData::prover_data`] method.
//! The verifier data can similarly be extracted by calling [`CircuitData::verifier_data`].
//! This is useful to allow even small devices to verify plonky2 proofs.

#[cfg(not(feature = "std"))]
use alloc::{collections::BTreeMap, vec, vec::Vec};
use core::ops::{Range, RangeFrom};
#[cfg(feature = "std")]
use std::collections::BTreeMap;

use anyhow::Result;
pub use qp_plonky2_core::CircuitConfig;
use serde::Serialize;

use super::circuit_builder::LookupWire;
use crate::field::extension::Extendable;
use crate::field::fft::FftRootTable;
use crate::field::types::Field;
use crate::fri::oracle::PolynomialBatch;
use crate::fri::structure::{
    FriBatchInfo, FriBatchInfoTarget, FriInstanceInfo, FriInstanceInfoTarget, FriOpeningExpression,
    FriOracleInfo, FriPolynomialInfo,
};
use crate::fri::FriParams;
// Re-export CircuitConfig from core
use crate::gates::gate::GateRef;
use crate::gates::lookup::Lookup;
use crate::gates::lookup_table::LookupTable;
use crate::gates::selectors::SelectorsInfo;
use crate::hash::hash_types::{HashOutTarget, MerkleCapTarget, RichField};
use crate::hash::merkle_tree::MerkleCap;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::generator::{generate_partial_witness, WitnessGeneratorRef};
use crate::iop::target::Target;
use crate::iop::witness::{PartialWitness, PartitionWitness};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::{AlgebraicHasher, GenericConfig, Hasher};
use crate::plonk::plonk_common::PlonkOracle;
use crate::plonk::proof::{CompressedProofWithPublicInputs, ProofWithPublicInputs};
use crate::plonk::prover::prove;
use crate::plonk::verifier::verify;
use crate::util::log2_ceil;
use crate::util::serialization::{
    Buffer, GateSerializer, IoResult, Read, WitnessGeneratorSerializer, Write,
};
use crate::util::timing::TimingTree;

/// Mock circuit data to only do witness generation without generating a proof.
#[derive(Eq, PartialEq, Debug)]
pub struct MockCircuitData<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
{
    pub prover_only: ProverOnlyCircuitData<F, C, D>,
    pub common: CommonCircuitData<F, D>,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    MockCircuitData<F, C, D>
{
    pub fn generate_witness(&self, inputs: PartialWitness<F>) -> PartitionWitness<'_, F> {
        generate_partial_witness::<F, C, D>(inputs, &self.prover_only, &self.common).unwrap()
    }
}

/// Circuit data required by the prover or the verifier.
#[derive(Eq, PartialEq, Debug)]
pub struct CircuitData<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize> {
    pub prover_only: ProverOnlyCircuitData<F, C, D>,
    pub verifier_only: VerifierOnlyCircuitData<C, D>,
    pub common: CommonCircuitData<F, D>,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    CircuitData<F, C, D>
{
    pub fn to_bytes(
        &self,
        gate_serializer: &dyn GateSerializer<F, D>,
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
    ) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_circuit_data(self, gate_serializer, generator_serializer)?;
        Ok(buffer)
    }

    pub fn from_bytes(
        bytes: &[u8],
        gate_serializer: &dyn GateSerializer<F, D>,
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
    ) -> IoResult<Self> {
        let mut buffer = Buffer::new(bytes);
        buffer.read_circuit_data(gate_serializer, generator_serializer)
    }

    pub fn prove(&self, inputs: PartialWitness<F>) -> Result<ProofWithPublicInputs<F, C, D>> {
        prove::<F, C, D>(
            &self.prover_only,
            &self.common,
            inputs,
            &mut TimingTree::default(),
        )
    }

    /// Verify a proof for this circuit.
    ///
    /// **IMPORTANT**: For cyclic recursive circuits (those using
    /// [`conditionally_verify_cyclic_proof`](crate::recursion::cyclic_recursion) or
    /// [`conditionally_verify_cyclic_proof_or_dummy`](crate::recursion::cyclic_recursion)),
    /// you MUST use [`verify_cyclic`](Self::verify_cyclic) instead. This method does not
    /// verify that the verifier data embedded in the proof's public inputs matches the
    /// actual circuit, which is required for cyclic recursion security.
    pub fn verify(&self, proof_with_pis: ProofWithPublicInputs<F, C, D>) -> Result<()> {
        verify::<F, C, D>(proof_with_pis, &self.verifier_only, &self.common)
    }

    /// Verify a cyclic recursive proof.
    ///
    /// This method MUST be used instead of [`verify`](Self::verify) for circuits that use
    /// cyclic recursion ([`conditionally_verify_cyclic_proof`](crate::recursion::cyclic_recursion)
    /// or [`conditionally_verify_cyclic_proof_or_dummy`](crate::recursion::cyclic_recursion)).
    ///
    /// In addition to standard proof verification, this checks that the verifier data
    /// embedded in the proof's public inputs matches the actual verifier data for this
    /// circuit. This prevents an attacker from substituting a valid proof chain built
    /// with a different (but structurally identical) circuit.
    ///
    /// # Security
    ///
    /// Without this check, an attacker could:
    /// 1. Build a malicious circuit with the same structure as the legitimate one
    /// 2. Create a valid proof chain using their circuit
    /// 3. Present it as a proof for the legitimate circuit
    ///
    /// The embedded verifier data check ensures the proof was actually generated for
    /// this specific circuit.
    pub fn verify_cyclic(&self, proof_with_pis: ProofWithPublicInputs<F, C, D>) -> Result<()>
    where
        C::Hasher: AlgebraicHasher<F>,
    {
        self.verify(proof_with_pis.clone())?;
        crate::recursion::cyclic_recursion::check_cyclic_proof_verifier_data(
            &proof_with_pis,
            &self.verifier_only,
            &self.common,
        )
    }

    pub fn verify_compressed(
        &self,
        compressed_proof_with_pis: CompressedProofWithPublicInputs<F, C, D>,
    ) -> Result<()> {
        compressed_proof_with_pis.verify(&self.verifier_only, &self.common)
    }

    pub fn compress(
        &self,
        proof: ProofWithPublicInputs<F, C, D>,
    ) -> Result<CompressedProofWithPublicInputs<F, C, D>> {
        proof.compress(&self.verifier_only.circuit_digest, &self.common)
    }

    pub fn decompress(
        &self,
        proof: CompressedProofWithPublicInputs<F, C, D>,
    ) -> Result<ProofWithPublicInputs<F, C, D>> {
        proof.decompress(&self.verifier_only.circuit_digest, &self.common)
    }

    pub fn verifier_data(&self) -> VerifierCircuitData<F, C, D> {
        let CircuitData {
            verifier_only,
            common,
            ..
        } = self;
        VerifierCircuitData {
            verifier_only: verifier_only.clone(),
            common: common.clone(),
        }
    }

    pub fn prover_data(self) -> ProverCircuitData<F, C, D> {
        let CircuitData {
            prover_only,
            common,
            ..
        } = self;
        ProverCircuitData {
            prover_only,
            common,
        }
    }
}

/// Circuit data required by the prover. This may be thought of as a proving key, although it
/// includes code for witness generation.
///
/// The goal here is to make proof generation as fast as we can, rather than making this prover
/// structure as succinct as we can. Thus we include various precomputed data which isn't strictly
/// required, like LDEs of preprocessed polynomials. If more succinctness was desired, we could
/// construct a more minimal prover structure and convert back and forth.
#[derive(Debug)]
pub struct ProverCircuitData<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
> {
    pub prover_only: ProverOnlyCircuitData<F, C, D>,
    pub common: CommonCircuitData<F, D>,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    ProverCircuitData<F, C, D>
{
    pub fn to_bytes(
        &self,
        gate_serializer: &dyn GateSerializer<F, D>,
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
    ) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_prover_circuit_data(self, gate_serializer, generator_serializer)?;
        Ok(buffer)
    }

    pub fn from_bytes(
        bytes: &[u8],
        gate_serializer: &dyn GateSerializer<F, D>,
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
    ) -> IoResult<Self> {
        let mut buffer = Buffer::new(bytes);
        buffer.read_prover_circuit_data(gate_serializer, generator_serializer)
    }

    pub fn prove(&self, inputs: PartialWitness<F>) -> Result<ProofWithPublicInputs<F, C, D>> {
        prove::<F, C, D>(
            &self.prover_only,
            &self.common,
            inputs,
            &mut TimingTree::default(),
        )
    }
}

/// Circuit data required by the verifier (a subset of the full circuit data).
///
/// This can be extracted from [`CircuitData`] via [`CircuitData::verifier_data`] and
/// distributed to verifiers who don't need the prover-specific data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierCircuitData<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
> {
    pub verifier_only: VerifierOnlyCircuitData<C, D>,
    pub common: CommonCircuitData<F, D>,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    VerifierCircuitData<F, C, D>
{
    pub fn to_bytes(&self, gate_serializer: &dyn GateSerializer<F, D>) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_verifier_circuit_data(self, gate_serializer)?;
        Ok(buffer)
    }

    pub fn from_bytes(
        bytes: Vec<u8>,
        gate_serializer: &dyn GateSerializer<F, D>,
    ) -> IoResult<Self> {
        let mut buffer = Buffer::new(&bytes);
        buffer.read_verifier_circuit_data(gate_serializer)
    }

    /// Verify a proof for this circuit.
    ///
    /// **IMPORTANT**: For cyclic recursive circuits (those using
    /// [`conditionally_verify_cyclic_proof`](crate::recursion::cyclic_recursion) or
    /// [`conditionally_verify_cyclic_proof_or_dummy`](crate::recursion::cyclic_recursion)),
    /// you MUST use [`verify_cyclic`](Self::verify_cyclic) instead. This method does not
    /// verify that the verifier data embedded in the proof's public inputs matches the
    /// actual circuit, which is required for cyclic recursion security.
    pub fn verify(&self, proof_with_pis: ProofWithPublicInputs<F, C, D>) -> Result<()> {
        verify::<F, C, D>(proof_with_pis, &self.verifier_only, &self.common)
    }

    /// Verify a cyclic recursive proof.
    ///
    /// This method MUST be used instead of [`verify`](Self::verify) for circuits that use
    /// cyclic recursion ([`conditionally_verify_cyclic_proof`](crate::recursion::cyclic_recursion)
    /// or [`conditionally_verify_cyclic_proof_or_dummy`](crate::recursion::cyclic_recursion)).
    ///
    /// In addition to standard proof verification, this checks that the verifier data
    /// embedded in the proof's public inputs matches the actual verifier data for this
    /// circuit. This prevents an attacker from substituting a valid proof chain built
    /// with a different (but structurally identical) circuit.
    ///
    /// # Security
    ///
    /// Without this check, an attacker could:
    /// 1. Build a malicious circuit with the same structure as the legitimate one
    /// 2. Create a valid proof chain using their circuit
    /// 3. Present it as a proof for the legitimate circuit
    ///
    /// The embedded verifier data check ensures the proof was actually generated for
    /// this specific circuit.
    pub fn verify_cyclic(&self, proof_with_pis: ProofWithPublicInputs<F, C, D>) -> Result<()>
    where
        C::Hasher: AlgebraicHasher<F>,
    {
        self.verify(proof_with_pis.clone())?;
        crate::recursion::cyclic_recursion::check_cyclic_proof_verifier_data(
            &proof_with_pis,
            &self.verifier_only,
            &self.common,
        )
    }

    pub fn verify_compressed(
        &self,
        compressed_proof_with_pis: CompressedProofWithPublicInputs<F, C, D>,
    ) -> Result<()> {
        compressed_proof_with_pis.verify(&self.verifier_only, &self.common)
    }
}

/// Circuit data required by the prover, but not the verifier.
#[derive(Eq, PartialEq, Debug)]
pub struct ProverOnlyCircuitData<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
> {
    pub generators: Vec<WitnessGeneratorRef<F, D>>,
    /// Generator indices (within the `Vec` above), indexed by the representative of each target
    /// they watch.
    pub generator_indices_by_watches: BTreeMap<usize, Vec<usize>>,
    /// Commitments to the constants polynomials and sigma polynomials.
    pub constants_sigmas_commitment: PolynomialBatch<F, C, D>,
    /// The transpose of the list of sigma polynomials.
    pub sigmas: Vec<Vec<F>>,
    /// Subgroup of order `degree`.
    pub subgroup: Vec<F>,
    /// Targets to be made public.
    pub public_inputs: Vec<Target>,
    /// A map from each `Target`'s index to the index of its representative in the disjoint-set
    /// forest.
    pub representative_map: Vec<usize>,
    /// Pre-computed roots for faster FFT.
    pub fft_root_table: Option<FftRootTable<F>>,
    /// A digest of the "circuit" (i.e. the instance, minus public inputs), which can be used to
    /// seed Fiat-Shamir.
    pub circuit_digest: <<C as GenericConfig<D>>::Hasher as Hasher<F>>::Hash,
    ///The concrete placement of the lookup gates for each lookup table index.
    pub lookup_rows: Vec<LookupWire>,
    /// A vector of (looking_in, looking_out) pairs for each lookup table index.
    pub lut_to_lookups: Vec<Lookup>,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    ProverOnlyCircuitData<F, C, D>
{
    pub fn to_bytes(
        &self,
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
        common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_prover_only_circuit_data(self, generator_serializer, common_data)?;
        Ok(buffer)
    }

    pub fn from_bytes(
        bytes: &[u8],
        generator_serializer: &dyn WitnessGeneratorSerializer<F, D>,
        common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<Self> {
        let mut buffer = Buffer::new(bytes);
        buffer.read_prover_only_circuit_data(generator_serializer, common_data)
    }
}

/// Circuit data required by the verifier, but not the prover.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct VerifierOnlyCircuitData<C: GenericConfig<D>, const D: usize> {
    /// A commitment to each constant polynomial and each permutation polynomial.
    pub constants_sigmas_cap: MerkleCap<C::F, C::Hasher>,
    /// A digest of the "circuit" (i.e. the instance, minus public inputs), which can be used to
    /// seed Fiat-Shamir.
    pub circuit_digest: <<C as GenericConfig<D>>::Hasher as Hasher<C::F>>::Hash,
}

impl<C: GenericConfig<D>, const D: usize> VerifierOnlyCircuitData<C, D> {
    pub fn to_bytes(&self) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_verifier_only_circuit_data(self)?;
        Ok(buffer)
    }

    pub fn from_bytes(bytes: Vec<u8>) -> IoResult<Self> {
        let mut buffer = Buffer::new(&bytes);
        buffer.read_verifier_only_circuit_data()
    }
}

/// Circuit data required by both the prover and the verifier.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct CommonCircuitData<F: RichField + Extendable<D>, const D: usize> {
    pub config: CircuitConfig,

    /// Trace degree bits of the underlying PLONK circuit.
    pub trace_degree_bits: usize,

    pub fri_params: FriParams,

    /// Shared public degree bits for the initial phase-1 FRI oracle commitments.
    /// This may be larger than the trace degree for certain configurations.
    pub public_initial_degree_bits: usize,

    /// The types of gates used in this circuit, along with their prefixes.
    pub gates: Vec<GateRef<F, D>>,

    /// Information on the circuit's selector polynomials.
    pub selectors_info: SelectorsInfo,

    /// The degree of the PLONK quotient polynomial.
    pub quotient_degree_factor: usize,

    /// The largest number of constraints imposed by any gate.
    pub num_gate_constraints: usize,

    /// The number of constant wires.
    pub num_constants: usize,

    pub num_public_inputs: usize,

    /// The `{k_i}` valued used in `S_ID_i` in Plonk's permutation argument.
    pub k_is: Vec<F>,

    /// The number of partial products needed to compute the `Z` polynomials.
    pub num_partial_products: usize,

    /// The number of lookup polynomials.
    pub num_lookup_polys: usize,

    /// The number of lookup selectors.
    pub num_lookup_selectors: usize,

    /// The stored lookup tables.
    pub luts: Vec<LookupTable>,
}

impl<F: RichField + Extendable<D>, const D: usize> CommonCircuitData<F, D> {
    /// Validate invariants required by the prover.
    ///
    /// This checks that degree parameters are consistent and within bounds.
    pub fn check_valid(&self) -> Result<(), &'static str> {
        qp_plonky2_core::circuit_config::check_common_data_valid(
            &self.config,
            self.quotient_degree_factor,
            self.config.fri_config.rate_bits,
            self.public_initial_degree_bits,
            self.trace_degree_bits,
            self.fri_params.degree_bits,
            || self.luts.iter().any(|lut| lut.is_empty()),
        )
    }

    pub fn to_bytes(&self, gate_serializer: &dyn GateSerializer<F, D>) -> IoResult<Vec<u8>> {
        let mut buffer = Vec::new();
        buffer.write_common_circuit_data(self, gate_serializer)?;
        Ok(buffer)
    }

    pub fn from_bytes(
        bytes: Vec<u8>,
        gate_serializer: &dyn GateSerializer<F, D>,
    ) -> IoResult<Self> {
        let mut buffer = Buffer::new(&bytes);
        buffer.read_common_circuit_data(gate_serializer)
    }

    /// Trace degree bits used by the PLONK identity checks and subgroup arithmetic.
    pub const fn degree_bits(&self) -> usize {
        self.trace_degree_bits
    }

    /// Degree bits for the public initial FRI codeword used by masked phase-1 oracles.
    pub const fn public_initial_degree_bits(&self) -> usize {
        self.public_initial_degree_bits
    }

    /// Degree of the public initial FRI codeword used by masked phase-1 oracles.
    pub const fn public_initial_degree(&self) -> usize {
        1 << self.public_initial_degree_bits()
    }

    /// LDE size of the public initial codeword used by masked phase-1 oracles.
    pub const fn public_initial_lde_size(&self) -> usize {
        self.public_initial_degree() << self.config.fri_config.rate_bits
    }

    /// Number of FFT points precomputed for the largest phase-1 commitment.
    ///
    /// Returns `None` when the degree parameters overflow `usize`, so deserialization can reject
    /// malformed circuit data instead of panicking.
    pub fn max_fft_points(&self) -> Option<usize> {
        let max_fft_degree_bits = self.degree_bits().max(self.public_initial_degree_bits());
        let fft_extra_bits = self
            .config
            .fri_config
            .rate_bits
            .max(log2_ceil(self.quotient_degree_factor));
        let fft_bits = max_fft_degree_bits.checked_add(fft_extra_bits)?;
        1usize.checked_shl(fft_bits as u32)
    }

    pub const fn degree(&self) -> usize {
        1 << self.degree_bits()
    }

    pub const fn lde_size(&self) -> usize {
        self.fri_params.lde_size()
    }

    pub fn lde_generator(&self) -> F {
        F::primitive_root_of_unity(self.degree_bits() + self.config.fri_config.rate_bits)
    }

    pub fn constraint_degree(&self) -> usize {
        self.gates
            .iter()
            .map(|g| g.0.degree())
            .max()
            .expect("No gates?")
    }

    pub const fn quotient_degree(&self) -> usize {
        self.quotient_degree_factor * self.degree()
    }

    /// The quotient degree factor determines partial-product chunk size.
    pub fn permutation_partial_product_degree(&self) -> usize {
        self.quotient_degree_factor
    }

    /// Lookup running-sum accumulators consume one degree in the filtered constraints,
    /// so their chunk size is one less than the quotient degree factor.
    pub fn lookup_accumulator_degree(&self) -> usize {
        self.quotient_degree_factor - 1
    }

    /// Range of the constants polynomials in the `constants_sigmas_commitment`.
    pub const fn constants_range(&self) -> Range<usize> {
        0..self.num_constants
    }

    /// Range of the sigma polynomials in the `constants_sigmas_commitment`.
    pub const fn sigmas_range(&self) -> Range<usize> {
        self.num_constants..self.num_constants + self.config.num_routed_wires
    }

    /// Range of the `z`s polynomials in the `zs_partial_products_commitment`.
    pub const fn zs_range(&self) -> Range<usize> {
        0..self.config.num_challenges
    }

    /// Range of the partial products polynomials in the `zs_partial_products_lookup_commitment`.
    pub const fn partial_products_range(&self) -> Range<usize> {
        self.config.num_challenges..(self.num_partial_products + 1) * self.config.num_challenges
    }

    /// Range of lookup polynomials in the `zs_partial_products_lookup_commitment`.
    pub const fn lookup_range(&self) -> RangeFrom<usize> {
        self.num_zs_partial_products_polys()..
    }

    /// Range of lookup polynomials needed for evaluation at `g * zeta`.
    pub const fn next_lookup_range(&self, i: usize) -> Range<usize> {
        self.num_zs_partial_products_polys() + i * self.num_lookup_polys
            ..self.num_zs_partial_products_polys() + i * self.num_lookup_polys + 2
    }

    pub(crate) fn get_fri_instance(&self, zeta: F::Extension) -> FriInstanceInfo<F, D> {
        // All polynomials are opened at zeta.
        let zeta_batch = FriBatchInfo {
            point: zeta,
            openings: self.fri_all_openings(),
        };

        // The Z polynomials are also opened at g * zeta.
        let g = F::Extension::primitive_root_of_unity(self.degree_bits());
        let zeta_next = g * zeta;
        let zeta_next_batch = FriBatchInfo {
            point: zeta_next,
            openings: self.fri_next_batch_openings(),
        };

        let openings = vec![zeta_batch, zeta_next_batch];
        FriInstanceInfo {
            oracles: self.fri_oracles(),
            batches: openings,
        }
    }

    pub(crate) fn get_fri_instance_target(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        zeta: ExtensionTarget<D>,
    ) -> FriInstanceInfoTarget<F, D> {
        // All polynomials are opened at zeta.
        let zeta_batch = FriBatchInfoTarget {
            point: zeta,
            openings: self.fri_all_openings(),
        };

        // The Z polynomials are also opened at g * zeta.
        let g = F::primitive_root_of_unity(self.degree_bits());
        let zeta_next = builder.mul_const_extension(g, zeta);
        let zeta_next_batch = FriBatchInfoTarget {
            point: zeta_next,
            openings: self.fri_next_batch_openings(),
        };

        let openings = vec![zeta_batch, zeta_next_batch];
        FriInstanceInfoTarget {
            oracles: self.fri_oracles(),
            batches: openings,
        }
    }

    fn fri_oracles(&self) -> Vec<FriOracleInfo> {
        vec![
            FriOracleInfo {
                num_polys: self.num_preprocessed_polys(),
                blinding: PlonkOracle::CONSTANTS_SIGMAS.blinding,
            },
            FriOracleInfo {
                num_polys: self.config.num_wires,
                blinding: PlonkOracle::WIRES.blinding,
            },
            FriOracleInfo {
                num_polys: self.num_zs_partial_products_polys() + self.num_all_lookup_polys(),
                blinding: PlonkOracle::ZS_PARTIAL_PRODUCTS.blinding,
            },
            FriOracleInfo {
                num_polys: self.num_quotient_polys(),
                blinding: PlonkOracle::QUOTIENT.blinding,
            },
        ]
    }

    pub(crate) const fn num_preprocessed_polys(&self) -> usize {
        self.sigmas_range().end
    }

    fn fri_oracle_openings<I>(
        &self,
        oracle: PlonkOracle,
        logical_indices: I,
    ) -> Vec<FriOpeningExpression<F, D>>
    where
        I: IntoIterator<Item = usize>,
    {
        logical_indices
            .into_iter()
            .map(|logical_index| {
                FriOpeningExpression::raw(FriPolynomialInfo {
                    oracle_index: oracle.index,
                    polynomial_index: logical_index,
                })
            })
            .collect()
    }

    fn fri_preprocessed_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(
            PlonkOracle::CONSTANTS_SIGMAS,
            0..self.num_preprocessed_polys(),
        )
    }

    fn fri_wire_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(PlonkOracle::WIRES, 0..self.config.num_wires)
    }

    fn fri_zs_partial_products_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(
            PlonkOracle::ZS_PARTIAL_PRODUCTS,
            0..self.num_zs_partial_products_polys(),
        )
    }

    pub(crate) const fn num_zs_partial_products_polys(&self) -> usize {
        self.config.num_challenges * (1 + self.num_partial_products)
    }

    /// Returns the total number of lookup polynomials.
    pub(crate) const fn num_all_lookup_polys(&self) -> usize {
        self.config.num_challenges * self.num_lookup_polys
    }

    fn fri_zs_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(PlonkOracle::ZS_PARTIAL_PRODUCTS, self.zs_range())
    }

    /// Returns polynomials that require evaluation at `zeta` and `g * zeta`.
    fn fri_next_batch_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        [self.fri_zs_openings(), self.fri_lookup_openings()].concat()
    }

    fn fri_quotient_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(PlonkOracle::QUOTIENT, 0..self.num_quotient_polys())
    }

    /// Returns the information for lookup polynomials, i.e. the index within the oracle and the indices of the polynomials within the commitment.
    fn fri_lookup_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(
            PlonkOracle::ZS_PARTIAL_PRODUCTS,
            self.num_zs_partial_products_polys()
                ..self.num_zs_partial_products_polys() + self.num_all_lookup_polys(),
        )
    }

    pub(crate) const fn num_quotient_polys(&self) -> usize {
        self.config.num_challenges * self.quotient_degree_factor
    }

    fn fri_all_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        [
            self.fri_preprocessed_openings(),
            self.fri_wire_openings(),
            self.fri_zs_partial_products_openings(),
            self.fri_quotient_openings(),
            self.fri_lookup_openings(),
        ]
        .concat()
    }
}

/// The `Target` version of `VerifierCircuitData`, for use inside recursive circuits. Note that this
/// is intentionally missing certain fields, such as `CircuitConfig`, because we support only a
/// limited form of dynamic inner circuits. We can't practically make things like the wire count
/// dynamic, at least not without setting a maximum wire count and paying for the worst case.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierCircuitTarget {
    /// A commitment to each constant polynomial and each permutation polynomial.
    pub constants_sigmas_cap: MerkleCapTarget,
    /// A digest of the "circuit" (i.e. the instance, minus public inputs), which can be used to
    /// seed Fiat-Shamir.
    pub circuit_digest: HashOutTarget,
}

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::sync::Arc;
    #[cfg(feature = "std")]
    use std::sync::Arc;

    use itertools::Itertools;

    use super::{CircuitConfig, CommonCircuitData};
    use crate::field::types::Field;
    use crate::gates::lookup::LookupGate;
    use crate::gates::lookup_table::LookupTable;
    use crate::gates::noop::NoopGate;
    use crate::plonk::circuit_builder::CircuitBuilder;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::util::partial_products::num_partial_products;

    const D: usize = 2;
    type C = PoseidonGoldilocksConfig;
    type F = <C as GenericConfig<D>>::F;

    fn build_common(config: CircuitConfig) -> CommonCircuitData<F, D> {
        let mut builder = CircuitBuilder::<F, D>::new(config);
        builder.add_gate(NoopGate, vec![]);
        builder.build::<C>().common
    }

    fn build_lookup_common(config: CircuitConfig) -> CommonCircuitData<F, D> {
        let table: LookupTable = Arc::new((0..4).zip_eq(1..5).collect());
        let mut builder = CircuitBuilder::<F, D>::new(config);
        let input = builder.constant(F::ONE);
        let table_index = builder.add_lookup_table_from_pairs(table);
        let _ = builder.add_lookup_from_index(input, table_index);
        builder.build::<C>().common
    }

    #[test]
    fn permutation_partial_product_degree_boundary() {
        let common = build_common(CircuitConfig::standard_recursion_config());
        let degree = common.permutation_partial_product_degree();

        assert_eq!(degree, common.quotient_degree_factor);
        assert_eq!(
            common.num_partial_products,
            num_partial_products(common.config.num_routed_wires, degree)
        );
    }

    #[test]
    fn lookup_accumulator_degree_boundary() {
        let common = build_lookup_common(CircuitConfig::standard_recursion_config());
        let degree = common.lookup_accumulator_degree();

        assert!(common.num_lookup_polys > 0);
        assert_eq!(degree, common.quotient_degree_factor - 1);
        assert_eq!(
            common.num_lookup_polys,
            LookupGate::num_slots(&common.config).div_ceil(degree) + 1,
        );
    }

    #[test]
    fn row_blinding_uses_same_degree_budgets() {
        let common = build_lookup_common(CircuitConfig::standard_recursion_zk_config());

        assert_eq!(
            common.permutation_partial_product_degree(),
            common.quotient_degree_factor
        );
        assert_eq!(
            common.lookup_accumulator_degree(),
            common.quotient_degree_factor - 1
        );
    }

    #[test]
    fn row_blinding_adds_builder_rows() {
        let disabled = build_common(CircuitConfig::standard_recursion_config());
        let row_blinding = build_common(CircuitConfig::standard_recursion_zk_config());

        assert!(
            row_blinding.degree() > disabled.degree(),
            "legacy row blinding should append witness rows before final padding",
        );
    }
}
