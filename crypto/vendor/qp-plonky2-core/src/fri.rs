//! FRI (Fast Reed-Solomon IOP) configuration types.
//!
//! These types are shared between the prover and verifier.

#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};

use log::debug;
use serde::Serialize;

use crate::challenger::Challenger;
use crate::config::{GenericConfig, Hasher};
use crate::field::extension::Extendable;
use crate::field::polynomial::PolynomialCoeffs;
use crate::field::types::Field;
use crate::fri_structure::{FriChallenges, FriOpenings};
use crate::hash_types::{RichField, NUM_HASH_OUT_ELTS};
use crate::merkle_tree::MerkleCap;

/// A method for deciding what arity to use at each reduction layer.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub enum FriReductionStrategy {
    /// Specifies the exact sequence of arities (expressed in bits) to use.
    Fixed(Vec<usize>),

    /// `ConstantArityBits(arity_bits, final_poly_bits)` applies reductions of arity `2^arity_bits`
    /// until the polynomial degree is less than or equal to `2^final_poly_bits` or until any further
    /// `arity_bits`-reduction makes the last FRI tree have height less than `cap_height`.
    /// This tends to work well in the recursive setting, as it avoids needing multiple configurations
    /// of gates used in FRI verification, such as `InterpolationGate`.
    ConstantArityBits(usize, usize),

    /// `MinSize(opt_max_arity_bits)` searches for an optimal sequence of reduction arities, with an
    /// optional max `arity_bits`. If this proof will have recursive proofs on top of it, a max
    /// `arity_bits` of 3 is recommended.
    MinSize(Option<usize>),
}

impl FriReductionStrategy {
    /// The arity of each FRI reduction step, expressed as the log2 of the actual arity.
    pub fn reduction_arity_bits(
        &self,
        mut degree_bits: usize,
        rate_bits: usize,
        cap_height: usize,
        num_queries: usize,
    ) -> Vec<usize> {
        match self {
            FriReductionStrategy::Fixed(reduction_arity_bits) => reduction_arity_bits.to_vec(),
            &FriReductionStrategy::ConstantArityBits(arity_bits, final_poly_bits) => {
                let mut result = Vec::new();
                while degree_bits > final_poly_bits
                    && degree_bits + rate_bits - arity_bits >= cap_height
                {
                    result.push(arity_bits);
                    assert!(degree_bits >= arity_bits);
                    degree_bits -= arity_bits;
                }
                result.shrink_to_fit();
                result
            }
            FriReductionStrategy::MinSize(opt_max_arity_bits) => {
                min_size_arity_bits(degree_bits, rate_bits, num_queries, *opt_max_arity_bits)
            }
        }
    }

    pub fn serialize<F: RichField>(&self) -> Vec<F> {
        match self {
            FriReductionStrategy::Fixed(reduction_arity_bits) => core::iter::once(F::ZERO)
                .chain(
                    reduction_arity_bits
                        .iter()
                        .map(|&x| F::from_canonical_usize(x)),
                )
                .collect(),
            FriReductionStrategy::ConstantArityBits(arity_bits, final_poly_bits) => {
                vec![
                    F::ONE,
                    F::from_canonical_usize(*arity_bits),
                    F::from_canonical_usize(*final_poly_bits),
                ]
            }
            FriReductionStrategy::MinSize(opt_max_arity_bits) => {
                let max_arity = opt_max_arity_bits.unwrap_or(0);
                vec![F::TWO, F::from_canonical_usize(max_arity)]
            }
        }
    }
}

fn min_size_arity_bits(
    degree_bits: usize,
    rate_bits: usize,
    num_queries: usize,
    opt_max_arity_bits: Option<usize>,
) -> Vec<usize> {
    // 2^4 is the largest arity we see in optimal reduction sequences in practice. For 2^5 to occur
    // in an optimal sequence, we would need a really massive polynomial.
    let max_arity_bits = opt_max_arity_bits.unwrap_or(4);

    let (mut arity_bits, fri_proof_size) =
        min_size_arity_bits_helper(degree_bits, rate_bits, num_queries, max_arity_bits, vec![]);
    arity_bits.shrink_to_fit();

    debug!(
        "Smallest arity_bits {:?} results in estimated FRI proof size of {} elements",
        arity_bits, fri_proof_size
    );

    arity_bits
}

/// Return `(arity_bits, fri_proof_size)`.
fn min_size_arity_bits_helper(
    degree_bits: usize,
    rate_bits: usize,
    num_queries: usize,
    global_max_arity_bits: usize,
    prefix: Vec<usize>,
) -> (Vec<usize>, usize) {
    let sum_of_arities: usize = prefix.iter().sum();
    let current_layer_bits = degree_bits + rate_bits - sum_of_arities;
    assert!(current_layer_bits >= rate_bits);

    let mut best_arity_bits = prefix.clone();
    let mut best_size = relative_proof_size(degree_bits, rate_bits, num_queries, &prefix);

    // The largest next_arity_bits to search. Note that any optimal arity sequence will be
    // monotonically non-increasing, as a larger arity will shrink more Merkle proofs if it occurs
    // earlier in the sequence.
    let max_arity_bits = prefix
        .last()
        .copied()
        .unwrap_or(global_max_arity_bits)
        .min(current_layer_bits - rate_bits);

    for next_arity_bits in 1..=max_arity_bits {
        let mut extended_prefix = prefix.clone();
        extended_prefix.push(next_arity_bits);

        let (arity_bits, size) = min_size_arity_bits_helper(
            degree_bits,
            rate_bits,
            num_queries,
            max_arity_bits,
            extended_prefix,
        );
        if size < best_size {
            best_arity_bits = arity_bits;
            best_size = size;
        }
    }

    (best_arity_bits, best_size)
}

/// Compute the approximate size of a FRI proof with the given reduction arities. Note that this
/// ignores initial evaluations, which aren't affected by arities, and some other minor
/// contributions. The result is measured in field elements.
fn relative_proof_size(
    degree_bits: usize,
    rate_bits: usize,
    num_queries: usize,
    arity_bits: &[usize],
) -> usize {
    const D: usize = 4;

    let mut current_layer_bits = degree_bits + rate_bits;

    let mut total_elems = 0;
    for arity_bits in arity_bits {
        let arity = 1 << arity_bits;

        // Add neighboring evaluations, which are extension field elements.
        total_elems += (arity - 1) * D * num_queries;
        // Add siblings in the Merkle path.
        total_elems += current_layer_bits * 4 * num_queries;

        current_layer_bits -= arity_bits;
    }

    // Add the final polynomial's coefficients.
    assert!(current_layer_bits >= rate_bits);
    let final_poly_len = 1 << (current_layer_bits - rate_bits);
    total_elems += D * final_poly_len;

    total_elems
}

/// A configuration for the FRI protocol.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct FriConfig {
    /// `rate = 2^{-rate_bits}`.
    pub rate_bits: usize,

    /// Height of Merkle tree caps.
    pub cap_height: usize,

    /// Number of bits used for grinding.
    pub proof_of_work_bits: u32,

    /// The reduction strategy to be applied at each layer during the commit phase.
    pub reduction_strategy: FriReductionStrategy,

    /// Number of query rounds to perform.
    pub num_query_rounds: usize,
}

impl FriConfig {
    pub fn rate(&self) -> f64 {
        1.0 / ((1 << self.rate_bits) as f64)
    }

    pub fn fri_params(&self, degree_bits: usize, leaf_hiding: bool) -> FriParams {
        let reduction_arity_bits = self.reduction_strategy.reduction_arity_bits(
            degree_bits,
            self.rate_bits,
            self.cap_height,
            self.num_query_rounds,
        );
        FriParams {
            config: self.clone(),
            leaf_hiding,
            degree_bits,
            reduction_arity_bits,
        }
    }

    pub const fn num_cap_elements(&self) -> usize {
        1 << self.cap_height
    }
}

/// FRI parameters, including generated parameters which are specific to an instance size, in
/// contrast to `FriConfig` which is user-specified and independent of instance size.
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct FriParams {
    /// User-specified FRI configuration.
    pub config: FriConfig,

    /// Whether to salt Merkle leaves for zero-knowledge.
    pub leaf_hiding: bool,

    /// The degree of the purported codeword, measured in bits.
    pub degree_bits: usize,

    /// The arity of each FRI reduction step, expressed as the log2 of the actual arity.
    /// For example, `[3, 2, 1]` would describe a FRI reduction tree with 8-to-1 reduction, then
    /// a 4-to-1 reduction, then a 2-to-1 reduction. After these reductions, the reduced polynomial
    /// is sent directly.
    pub reduction_arity_bits: Vec<usize>,
}

impl FriParams {
    pub fn total_arities(&self) -> usize {
        self.reduction_arity_bits.iter().sum()
    }

    pub fn max_arity_bits(&self) -> Option<usize> {
        self.reduction_arity_bits.iter().copied().max()
    }

    pub const fn lde_bits(&self) -> usize {
        self.degree_bits + self.config.rate_bits
    }

    pub const fn lde_size(&self) -> usize {
        1 << self.lde_bits()
    }

    pub fn final_poly_bits(&self) -> usize {
        self.degree_bits - self.total_arities()
    }

    pub fn final_poly_len(&self) -> usize {
        1 << self.final_poly_bits()
    }
}

/// Trait for observing FRI configuration in a Challenger.
///
/// This allows the FRI config to be incorporated into the Fiat-Shamir transcript.
pub trait FriConfigObserve {
    /// Observe the FRI configuration parameters in a Challenger.
    fn observe<F: RichField, H: Hasher<F>>(&self, challenger: &mut Challenger<F, H>);
}

impl FriConfigObserve for FriConfig {
    fn observe<F: RichField, H: Hasher<F>>(&self, challenger: &mut Challenger<F, H>) {
        challenger.observe_element(F::from_canonical_usize(self.rate_bits));
        challenger.observe_element(F::from_canonical_usize(self.cap_height));
        challenger.observe_element(F::from_canonical_u32(self.proof_of_work_bits));
        challenger.observe_elements(&self.reduction_strategy.serialize());
        challenger.observe_element(F::from_canonical_usize(self.num_query_rounds));
    }
}

/// Trait for observing FRI parameters in a Challenger.
///
/// This allows the FRI params to be incorporated into the Fiat-Shamir transcript.
pub trait FriParamsObserve {
    /// Observe the FRI parameters in a Challenger.
    fn observe<F: RichField, H: Hasher<F>>(&self, challenger: &mut Challenger<F, H>);
}

impl FriParamsObserve for FriParams {
    fn observe<F: RichField, H: Hasher<F>>(&self, challenger: &mut Challenger<F, H>) {
        self.config.observe(challenger);

        challenger.observe_element(F::from_bool(self.leaf_hiding));
        challenger.observe_element(F::from_canonical_usize(self.degree_bits));
        challenger.observe_elements(
            &self
                .reduction_arity_bits
                .iter()
                .map(|&e| F::from_canonical_usize(e))
                .collect::<Vec<_>>(),
        );
    }
}

/// Trait for Challenger with FRI-specific methods.
///
/// This trait provides methods for observing FRI openings and generating
/// FRI challenges during verification.
pub trait FriChallenger<F: RichField, H: Hasher<F>> {
    /// Observe FRI openings.
    fn observe_openings<const D: usize>(&mut self, openings: &FriOpenings<F, D>)
    where
        F: RichField + Extendable<D>;

    /// Generate FRI challenges.
    fn fri_challenges<C: GenericConfig<D, F = F>, const D: usize>(
        &mut self,
        commit_phase_merkle_caps: &[MerkleCap<F, C::Hasher>],
        final_poly: &PolynomialCoeffs<F::Extension>,
        pow_witness: F,
        degree_bits: usize,
        config: &FriConfig,
        final_poly_coeff_len: Option<usize>,
        max_num_query_steps: Option<usize>,
    ) -> FriChallenges<F, D>
    where
        F: RichField + Extendable<D>;
}

impl<F: RichField, H: Hasher<F>> FriChallenger<F, H> for Challenger<F, H> {
    fn observe_openings<const D: usize>(&mut self, openings: &FriOpenings<F, D>)
    where
        F: RichField + Extendable<D>,
    {
        for v in &openings.batches {
            self.observe_extension_elements(&v.values);
        }
    }

    fn fri_challenges<C: GenericConfig<D, F = F>, const D: usize>(
        &mut self,
        commit_phase_merkle_caps: &[MerkleCap<F, C::Hasher>],
        final_poly: &PolynomialCoeffs<F::Extension>,
        pow_witness: F,
        degree_bits: usize,
        config: &FriConfig,
        final_poly_coeff_len: Option<usize>,
        max_num_query_steps: Option<usize>,
    ) -> FriChallenges<F, D>
    where
        F: RichField + Extendable<D>,
    {
        let num_fri_queries = config.num_query_rounds;
        let lde_size = 1 << (degree_bits + config.rate_bits);
        // Scaling factor to combine polynomials.
        let fri_alpha = self.get_extension_challenge::<D>();

        // Recover the random betas used in the FRI reductions.
        let fri_betas = commit_phase_merkle_caps
            .iter()
            .map(|cap| {
                self.observe_cap::<C::Hasher>(cap);
                self.get_extension_challenge::<D>()
            })
            .collect();

        // When this proof was generated in a circuit with a different number of query steps,
        // the challenger needs to observe the additional hash caps.
        if let Some(step_count) = max_num_query_steps {
            let cap_len = (1 << config.cap_height) * NUM_HASH_OUT_ELTS;
            let zero_cap = vec![F::ZERO; cap_len];
            for _ in commit_phase_merkle_caps.len()..step_count {
                self.observe_elements(&zero_cap);
                self.get_extension_challenge::<D>();
            }
        }

        self.observe_extension_elements(&final_poly.coeffs);
        // When this proof was generated in a circuit with a different final polynomial length,
        // the challenger needs to observe the full length so native and
        // recursive transcripts stay aligned.
        if let Some(len) = final_poly_coeff_len {
            let current_len = final_poly.len();
            for _ in current_len..len {
                self.observe_extension_element(&F::Extension::ZERO);
            }
        }

        self.observe_element(pow_witness);
        let fri_pow_response = self.get_challenge();

        let fri_query_indices = (0..num_fri_queries)
            .map(|_| self.get_challenge().to_canonical_u64() as usize % lde_size)
            .collect();

        FriChallenges {
            fri_alpha,
            fri_betas,
            fri_pow_response,
            fri_query_indices,
        }
    }
}
