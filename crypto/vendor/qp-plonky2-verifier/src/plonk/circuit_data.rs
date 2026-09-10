//! Circuit data specific to the verifier.
//!
//! This module defines the data structures needed for proof verification.

#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};
use core::ops::{Range, RangeFrom};

use anyhow::{ensure, Result};
use qp_plonky2_core::merkle_tree::MerkleCap;
// Re-export CircuitConfig from core
pub use qp_plonky2_core::CircuitConfig;
use qp_plonky2_core::FriParams;
use serde::Serialize;

use crate::field::extension::Extendable;
use crate::field::types::Field;
use crate::fri::structure::{
    FriBatchInfo, FriInstanceInfo, FriOpeningExpression, FriOracleInfo, FriPolynomialInfo,
};
use crate::gates::gate::GateRef;
use crate::gates::lookup_table::LookupTable;
use crate::gates::selectors::SelectorsInfo;
use crate::hash::hash_types::{HashOut, RichField};
use crate::plonk::config::{GenericConfig, Hasher};
use crate::plonk::plonk_common::PlonkOracle;
use crate::plonk::proof::{CompressedProofWithPublicInputs, ProofWithPublicInputs};
use crate::plonk::verifier::verify;
use crate::util::serialization::{Buffer, GateSerializer, IoResult, Read, Write};

/// Circuit data required by the verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierCircuitData<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
> {
    pub verifier_only: VerifierOnlyCircuitData<C, D>,
    pub common: CommonVerifierData<F, D>,
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
    /// **IMPORTANT**: For cyclic recursive circuits, you MUST use
    /// [`verify_cyclic`](Self::verify_cyclic) instead. This method does not verify that
    /// the verifier data embedded in the proof's public inputs matches the actual circuit,
    /// which is required for cyclic recursion security.
    pub fn verify(&self, proof_with_pis: ProofWithPublicInputs<F, C, D>) -> Result<()> {
        verify::<F, C, D>(proof_with_pis, &self.verifier_only, &self.common)
    }

    /// Verify a cyclic recursive proof.
    ///
    /// This method MUST be used instead of [`verify`](Self::verify) for circuits that use
    /// cyclic recursion.
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
        C::Hasher: Hasher<F, Hash = HashOut<F>>,
    {
        self.verify(proof_with_pis.clone())?;
        check_cyclic_proof_verifier_data(&proof_with_pis, &self.verifier_only, &self.common)
    }

    pub fn verify_compressed(
        &self,
        compressed_proof_with_pis: CompressedProofWithPublicInputs<F, C, D>,
    ) -> Result<()> {
        compressed_proof_with_pis.verify(&self.verifier_only, &self.common)
    }
}

/// Circuit data required by the verifier only (not the prover).
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

    /// Extract verifier data from public inputs (for cyclic proof verification).
    ///
    /// The verifier data is stored at the end of public inputs in the format:
    /// `[..., circuit_digest (4 elements), constants_sigmas_cap (4 * cap_len elements)]`
    fn from_slice(slice: &[C::F], common_data: &CommonVerifierData<C::F, D>) -> Result<Self>
    where
        C::Hasher: Hasher<C::F, Hash = HashOut<C::F>>,
    {
        let cap_len = common_data.config.fri_config.num_cap_elements();
        let len = slice.len();
        ensure!(
            len >= 4 + 4 * cap_len,
            "Not enough public inputs for verifier data"
        );
        let constants_sigmas_cap = MerkleCap(
            (0..cap_len)
                .map(|i| HashOut {
                    elements: core::array::from_fn(|j| slice[len - 4 * (cap_len - i) + j]),
                })
                .collect(),
        );
        let circuit_digest =
            HashOut::from_partial(&slice[len - 4 - 4 * cap_len..len - 4 * cap_len]);

        Ok(Self {
            circuit_digest,
            constants_sigmas_cap,
        })
    }
}

/// Checks that the verifier data embedded in a cyclic proof's public inputs matches
/// the expected verifier data for the circuit.
///
/// This is called automatically by [`VerifierCircuitData::verify_cyclic`].
pub fn check_cyclic_proof_verifier_data<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
>(
    proof: &ProofWithPublicInputs<F, C, D>,
    verifier_data: &VerifierOnlyCircuitData<C, D>,
    common_data: &CommonVerifierData<F, D>,
) -> Result<()>
where
    C::Hasher: Hasher<F, Hash = HashOut<F>>,
{
    let pis = VerifierOnlyCircuitData::<C, D>::from_slice(&proof.public_inputs, common_data)?;
    ensure!(
        verifier_data.constants_sigmas_cap == pis.constants_sigmas_cap,
        "Cyclic proof verifier data mismatch: constants_sigmas_cap does not match"
    );
    ensure!(
        verifier_data.circuit_digest == pis.circuit_digest,
        "Cyclic proof verifier data mismatch: circuit_digest does not match"
    );

    Ok(())
}

/// Verification-specific circuit data.
///
/// This contains the data needed for proof verification. It is a lighter
/// version of the prover's `CommonCircuitData`, containing only what the
/// verifier needs.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct CommonVerifierData<F: RichField + Extendable<D>, const D: usize> {
    pub config: CircuitConfig,

    /// Trace degree bits of the underlying PLONK circuit.
    pub trace_degree_bits: usize,

    pub fri_params: FriParams,

    /// Shared public degree bits for the initial phase-1 FRI oracle commitments.
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

impl<F: RichField + Extendable<D>, const D: usize> CommonVerifierData<F, D> {
    /// Validate invariants required by the verifier.
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

    pub(crate) const fn num_zs_partial_products_polys(&self) -> usize {
        self.config.num_challenges * (1 + self.num_partial_products)
    }

    fn fri_zs_partial_products_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(
            PlonkOracle::ZS_PARTIAL_PRODUCTS,
            0..self.num_zs_partial_products_polys(),
        )
    }

    /// Returns the total number of lookup polynomials.
    pub(crate) const fn num_all_lookup_polys(&self) -> usize {
        self.config.num_challenges * self.num_lookup_polys
    }

    fn fri_zs_openings(&self) -> Vec<FriOpeningExpression<F, D>> {
        self.fri_oracle_openings(PlonkOracle::ZS_PARTIAL_PRODUCTS, self.zs_range())
    }

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

/// Type alias for backward compatibility.
pub type CommonCircuitData<F, const D: usize> = CommonVerifierData<F, D>;
