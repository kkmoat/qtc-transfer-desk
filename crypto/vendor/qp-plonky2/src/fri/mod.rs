//! Fast Reed-Solomon IOP (FRI) protocol.
//!
//! It provides both a native implementation and an in-circuit version
//! of the FRI verifier for recursive proof composition.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use plonky2_field::extension::Extendable;

use crate::hash::hash_types::RichField;
use crate::iop::challenger::RecursiveChallenger;
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::AlgebraicHasher;

pub mod challenges;
pub mod oracle;
pub mod proof;
pub mod prover;
pub mod recursive_verifier;
pub mod structure;
pub(crate) mod validate_shape;
pub mod verifier;
pub mod witness_util;

// Re-export FRI types from core
pub use qp_plonky2_core::{
    FriChallenger, FriConfig, FriConfigObserve, FriParams, FriParamsObserve, FriReductionStrategy,
};

/// Trait for observing FRI configuration in a RecursiveChallenger (circuit target version).
///
/// This is used for recursive verification where the FRI config must be observed
/// as circuit targets.
pub trait FriConfigObserveTarget {
    /// Observe the FRI configuration parameters in a RecursiveChallenger.
    fn observe_target<F, H, const D: usize>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        challenger: &mut RecursiveChallenger<F, H, D>,
    ) where
        F: RichField + Extendable<D>,
        H: AlgebraicHasher<F>;
}

impl FriConfigObserveTarget for FriConfig {
    fn observe_target<F, H, const D: usize>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        challenger: &mut RecursiveChallenger<F, H, D>,
    ) where
        F: RichField + Extendable<D>,
        H: AlgebraicHasher<F>,
    {
        challenger.observe_element(builder.constant(F::from_canonical_usize(self.rate_bits)));
        challenger.observe_element(builder.constant(F::from_canonical_usize(self.cap_height)));
        challenger
            .observe_element(builder.constant(F::from_canonical_u32(self.proof_of_work_bits)));
        challenger.observe_elements(&builder.constants(&self.reduction_strategy.serialize()));
        challenger
            .observe_element(builder.constant(F::from_canonical_usize(self.num_query_rounds)));
    }
}

/// Trait for observing FRI parameters in a RecursiveChallenger (circuit target version).
///
/// This is used for recursive verification where the FRI params must be observed
/// as circuit targets.
pub trait FriParamsObserveTarget {
    /// Observe the FRI parameters in a RecursiveChallenger.
    fn observe_target<F, H, const D: usize>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        challenger: &mut RecursiveChallenger<F, H, D>,
    ) where
        F: RichField + Extendable<D>,
        H: AlgebraicHasher<F>;
}

impl FriParamsObserveTarget for FriParams {
    fn observe_target<F, H, const D: usize>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        challenger: &mut RecursiveChallenger<F, H, D>,
    ) where
        F: RichField + Extendable<D>,
        H: AlgebraicHasher<F>,
    {
        self.config.observe_target(builder, challenger);

        challenger.observe_element(builder.constant(F::from_bool(self.leaf_hiding)));
        challenger.observe_element(builder.constant(F::from_canonical_usize(self.degree_bits)));
        challenger.observe_elements(
            &builder.constants(
                &self
                    .reduction_arity_bits
                    .iter()
                    .map(|&e| F::from_canonical_usize(e))
                    .collect::<Vec<_>>(),
            ),
        );
    }
}
