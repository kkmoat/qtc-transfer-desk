//! Information about the structure of a FRI instance, in terms of the oracles and polynomials
//! involved, and the points they are opened at.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

// Re-export base FRI structure types from core
pub use qp_plonky2_core::{
    FriBatchInfo, FriCoefficient, FriInstanceInfo, FriOpeningBatch, FriOpeningExpression,
    FriOpeningTerm, FriOpenings, FriOracleInfo, FriPolynomialInfo,
};

use crate::field::extension::Extendable;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::ExtensionTarget;

pub type FriPolynomialInfoTarget = FriPolynomialInfo;
pub type FriCoefficientTarget<F, const D: usize> = FriCoefficient<F, D>;
pub type FriOpeningTermTarget<F, const D: usize> = FriOpeningTerm<F, D>;
pub type FriOpeningExpressionTarget<F, const D: usize> = FriOpeningExpression<F, D>;

/// Describes an instance of a FRI-based batch opening (circuit target version).
#[derive(Debug)]
pub struct FriInstanceInfoTarget<F: RichField + Extendable<D>, const D: usize> {
    /// The oracles involved, not counting oracles created during the commit phase.
    pub oracles: Vec<FriOracleInfo>,
    /// Batches of openings, where each batch is associated with a particular point.
    pub batches: Vec<FriBatchInfoTarget<F, D>>,
}

/// A batch of openings at a particular point (circuit target version).
#[derive(Debug)]
pub struct FriBatchInfoTarget<F: RichField + Extendable<D>, const D: usize> {
    pub point: ExtensionTarget<D>,
    /// Target-side metadata mirrors the native logical opening expressions exactly, so recursive
    /// verification combines raw oracle evaluations with the same coefficients and ordering.
    pub openings: Vec<FriOpeningExpressionTarget<F, D>>,
}

/// Opened values of each polynomial (circuit target version).
#[derive(Debug)]
pub struct FriOpeningsTarget<const D: usize> {
    pub batches: Vec<FriOpeningBatchTarget<D>>,
}

/// Opened values of each polynomial that's opened at a particular point (circuit target version).
#[derive(Debug)]
pub struct FriOpeningBatchTarget<const D: usize> {
    pub values: Vec<ExtensionTarget<D>>,
}
