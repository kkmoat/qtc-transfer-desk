use alloc::vec::Vec;

use anyhow::{ensure, Result};

use crate::packed::PackedField;
use crate::types::Field;

const MAX_ZERO_POLY_COSET_RATE_BITS: usize = 20;

/// Precomputations of the evaluation of `Z_H(X) = X^n - 1` on a coset `gK` with `H <= K`.
#[derive(Debug)]
pub struct ZeroPolyOnCoset<F: Field> {
    /// `n = |H|`.
    n: F,
    /// `rate = |K|/|H|`.
    rate: usize,
    /// Holds `g^n * (w^n)^i - 1 = g^n * v^i - 1` for `i in 0..rate`, with `w` a generator of `K` and `v` a
    /// `rate`-primitive root of unity.
    evals: Vec<F>,
    /// Holds the multiplicative inverses of `evals`.
    inverses: Vec<F>,
}

impl<F: Field> ZeroPolyOnCoset<F> {
    pub fn new(n_log: usize, rate_bits: usize) -> Self {
        Self::try_new(n_log, rate_bits).expect("invalid ZeroPolyOnCoset parameters")
    }

    pub fn try_new(n_log: usize, rate_bits: usize) -> Result<Self> {
        ensure!(n_log <= F::TWO_ADICITY, "n_log exceeds field two-adicity");
        ensure!(
            rate_bits <= F::TWO_ADICITY,
            "rate_bits exceeds field two-adicity"
        );
        ensure!(
            n_log
                .checked_add(rate_bits)
                .is_some_and(|bits| bits <= F::TWO_ADICITY),
            "combined coset domain exceeds field two-adicity"
        );
        ensure!(
            rate_bits <= MAX_ZERO_POLY_COSET_RATE_BITS,
            "ZeroPolyOnCoset rate_bits exceeds resource bound"
        );
        let n = 1usize
            .checked_shl(n_log as u32)
            .ok_or_else(|| anyhow::anyhow!("n_log shift overflow"))?;
        let rate = 1usize
            .checked_shl(rate_bits as u32)
            .ok_or_else(|| anyhow::anyhow!("rate_bits shift overflow"))?;

        let g_pow_n = F::coset_shift().exp_power_of_2(n_log);
        let evals = F::two_adic_subgroup(rate_bits)
            .into_iter()
            .map(|x| g_pow_n * x - F::ONE)
            .collect::<Vec<_>>();
        let inverses = F::batch_multiplicative_inverse(&evals);
        Ok(Self {
            n: F::from_canonical_usize(n),
            rate,
            evals,
            inverses,
        })
    }

    /// Returns `Z_H(g * w^i)`.
    pub fn eval(&self, i: usize) -> F {
        self.evals[i % self.rate]
    }

    /// Returns `1 / Z_H(g * w^i)`.
    pub fn eval_inverse(&self, i: usize) -> F {
        self.inverses[i % self.rate]
    }

    /// Like `eval_inverse`, but for a range of indices starting with `i_start`.
    pub fn eval_inverse_packed<P: PackedField<Scalar = F>>(&self, i_start: usize) -> P {
        let mut packed = P::ZEROS;
        packed
            .as_slice_mut()
            .iter_mut()
            .enumerate()
            .for_each(|(j, packed_j)| *packed_j = self.eval_inverse(i_start + j));
        packed
    }

    /// Returns `L_0(x) = Z_H(x)/(n * (x - 1))` with `x = w^i`.
    pub fn eval_l_0(&self, i: usize, x: F) -> F {
        // Could also precompute the inverses using Montgomery.
        self.eval(i) * (self.n * (x - F::ONE)).inverse()
    }
}
