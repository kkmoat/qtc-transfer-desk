//! Utility methods and constants for Plonk.
//!
//! Core types and functions are re-exported from qp-plonky2-core.
//! Circuit-specific functions are defined locally.

// Re-export common types and functions from core
pub use qp_plonky2_core::plonk_common::{
    eval_l_0, eval_zero_poly, reduce_with_powers, reduce_with_powers_multi, salt_size, PlonkOracle,
    SALT_SIZE,
};

use crate::field::extension::Extendable;
use crate::gates::arithmetic_base::ArithmeticGate;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::util::reducing::ReducingFactorTarget;

/// Evaluates the Lagrange basis L_0(x), which has L_0(1) = 1 and vanishes at all other points in
/// the order-`n` subgroup.
///
/// Assumes `x != 1`; if `x` could be 1 then this is unsound.
pub(crate) fn eval_l_0_circuit<F: RichField + Extendable<D>, const D: usize>(
    builder: &mut CircuitBuilder<F, D>,
    n: usize,
    x: ExtensionTarget<D>,
    x_pow_n: ExtensionTarget<D>,
) -> ExtensionTarget<D> {
    // L_0(x) = (x^n - 1) / (n * (x - 1))
    //        = Z(x) / (n * (x - 1))
    let one = builder.one_extension();
    let neg_one = builder.neg_one();
    let neg_one = builder.convert_to_ext(neg_one);
    let eval_zero_poly = builder.sub_extension(x_pow_n, one);
    let denominator = builder.arithmetic_extension(
        F::from_canonical_usize(n),
        F::from_canonical_usize(n),
        x,
        one,
        neg_one,
    );
    builder.div_extension(eval_zero_poly, denominator)
}

pub fn reduce_with_powers_circuit<F: RichField + Extendable<D>, const D: usize>(
    builder: &mut CircuitBuilder<F, D>,
    terms: &[Target],
    alpha: Target,
) -> Target {
    if terms.len() <= ArithmeticGate::new_from_config(&builder.config).num_ops + 1 {
        terms
            .iter()
            .rev()
            .fold(builder.zero(), |acc, &t| builder.mul_add(alpha, acc, t))
    } else {
        let alpha = builder.convert_to_ext(alpha);
        let mut alpha = ReducingFactorTarget::new(alpha);
        alpha.reduce_base(terms, builder).0[0]
    }
}

pub fn reduce_with_powers_ext_circuit<F: RichField + Extendable<D>, const D: usize>(
    builder: &mut CircuitBuilder<F, D>,
    terms: &[ExtensionTarget<D>],
    alpha: Target,
) -> ExtensionTarget<D> {
    let alpha = builder.convert_to_ext(alpha);
    let mut alpha = ReducingFactorTarget::new(alpha);
    alpha.reduce(terms, builder)
}
