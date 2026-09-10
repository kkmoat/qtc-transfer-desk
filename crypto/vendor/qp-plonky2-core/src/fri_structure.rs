//! FRI structure types shared between prover and verifier.
//!
//! These types describe the structure of FRI openings and challenges.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::ops::Range;

use serde::Serialize;

use crate::field::extension::Extendable;
use crate::hash_types::RichField;

/// Describes an instance of a FRI-based batch opening.
#[derive(Clone, Debug)]
pub struct FriInstanceInfo<F: RichField + Extendable<D>, const D: usize> {
    /// The oracles involved, not counting oracles created during the commit phase.
    pub oracles: Vec<FriOracleInfo>,
    /// Batches of openings, where each batch is associated with a particular point.
    pub batches: Vec<FriBatchInfo<F, D>>,
}

/// Information about a FRI oracle.
#[derive(Copy, Clone, Debug, Serialize)]
pub struct FriOracleInfo {
    pub num_polys: usize,
    pub blinding: bool,
}

/// A batch of openings at a particular point.
#[derive(Clone, Debug)]
pub struct FriBatchInfo<F: RichField + Extendable<D>, const D: usize> {
    pub point: F::Extension,
    pub openings: Vec<FriOpeningExpression<F, D>>,
}

/// Information about a polynomial in a FRI oracle.
#[derive(Copy, Clone, Debug, Serialize)]
pub struct FriPolynomialInfo {
    /// Index into `FriInstanceInfo`'s `oracles` list.
    pub oracle_index: usize,
    /// Index of the polynomial within the oracle.
    pub polynomial_index: usize,
}

impl FriPolynomialInfo {
    pub fn from_range(
        oracle_index: usize,
        polynomial_indices: Range<usize>,
    ) -> Vec<FriPolynomialInfo> {
        polynomial_indices
            .map(|polynomial_index| FriPolynomialInfo {
                oracle_index,
                polynomial_index,
            })
            .collect()
    }
}

/// A logical opening can be a raw polynomial or a linear combination of committed raw pieces.
#[derive(Clone, Debug, Serialize)]
#[serde(bound = "")]
pub struct FriOpeningExpression<F: RichField + Extendable<D>, const D: usize> {
    pub terms: Vec<FriOpeningTerm<F, D>>,
}

impl<F: RichField + Extendable<D>, const D: usize> FriOpeningExpression<F, D> {
    pub fn raw(polynomial: FriPolynomialInfo) -> Self {
        let terms = Vec::from([FriOpeningTerm {
            polynomial,
            coefficient: FriCoefficient::One,
        }]);
        Self { terms }
    }

    pub fn split_mask(low: FriPolynomialInfo, high: FriPolynomialInfo, split_power: usize) -> Self {
        let terms = Vec::from([
            FriOpeningTerm {
                polynomial: low,
                coefficient: FriCoefficient::One,
            },
            FriOpeningTerm {
                polynomial: high,
                coefficient: FriCoefficient::PointPower(split_power),
            },
        ]);
        Self { terms }
    }
}

/// One term in a logical opening expression.
#[derive(Clone, Debug, Serialize)]
#[serde(bound = "")]
pub struct FriOpeningTerm<F: RichField + Extendable<D>, const D: usize> {
    pub polynomial: FriPolynomialInfo,
    pub coefficient: FriCoefficient<F, D>,
}

/// Coefficients used when reconstructing a logical opening at a batch point.
#[derive(Clone, Debug, Serialize)]
#[serde(bound = "")]
pub enum FriCoefficient<F: RichField + Extendable<D>, const D: usize> {
    One,
    PointPower(usize),
    Constant(F::Extension),
}

/// Opened values of each polynomial.
#[derive(Debug)]
pub struct FriOpenings<F: RichField + Extendable<D>, const D: usize> {
    pub batches: Vec<FriOpeningBatch<F, D>>,
}

/// Opened values of each polynomial that's opened at a particular point.
#[derive(Debug)]
pub struct FriOpeningBatch<F: RichField + Extendable<D>, const D: usize> {
    pub values: Vec<F::Extension>,
}

/// Challenges generated during FRI verification.
#[derive(Debug)]
pub struct FriChallenges<F: RichField + Extendable<D>, const D: usize> {
    /// Scaling factor to combine polynomials.
    pub fri_alpha: F::Extension,

    /// Betas used in the FRI commit phase reductions.
    pub fri_betas: Vec<F::Extension>,

    /// Proof of work response.
    pub fri_pow_response: F,

    /// Indices at which the oracle is queried in FRI.
    pub fri_query_indices: Vec<usize>,
}
