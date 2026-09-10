//! Reducing factor utilities for FRI verification.
//!
//! `ReducingFactor` is re-exported from core.
//! `ReducingFactorTarget` (circuit-specific) is defined locally.

#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};

// Re-export ReducingFactor from core
pub use qp_plonky2_core::reducing::ReducingFactor;

use crate::field::extension::Extendable;
use crate::gates::arithmetic_extension::ArithmeticExtensionGate;
use crate::gates::reducing::ReducingGate;
use crate::gates::reducing_extension::ReducingExtensionGate;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;

#[derive(Debug, Clone)]
pub struct ReducingFactorTarget<const D: usize> {
    base: ExtensionTarget<D>,
    count: u64,
}

impl<const D: usize> ReducingFactorTarget<D> {
    pub const fn new(base: ExtensionTarget<D>) -> Self {
        Self { base, count: 0 }
    }

    /// Reduces a vector of `Target`s using `ReducingGate`s.
    pub fn reduce_base<F>(
        &mut self,
        terms: &[Target],
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>
    where
        F: RichField + Extendable<D>,
    {
        let l = terms.len();

        // For small reductions, use an arithmetic gate.
        if l <= ArithmeticExtensionGate::<D>::new_from_config(&builder.config).num_ops + 1 {
            let terms_ext = terms
                .iter()
                .map(|&t| builder.convert_to_ext(t))
                .collect::<Vec<_>>();
            return self.reduce_arithmetic(&terms_ext, builder);
        }

        let max_coeffs_len = ReducingGate::<D>::max_coeffs_len(
            builder.config.num_wires,
            builder.config.num_routed_wires,
        );
        self.count += l as u64;
        let zero = builder.zero();
        let zero_ext = builder.zero_extension();
        let mut acc = zero_ext;
        let mut reversed_terms = terms.to_vec();
        while reversed_terms.len() % max_coeffs_len != 0 {
            reversed_terms.push(zero);
        }
        reversed_terms.reverse();
        for chunk in reversed_terms.chunks_exact(max_coeffs_len) {
            let gate = ReducingGate::new(max_coeffs_len);
            let row = builder.add_gate(gate.clone(), vec![]);

            builder.connect_extension(
                self.base,
                ExtensionTarget::from_range(row, ReducingGate::<D>::wires_alpha()),
            );
            builder.connect_extension(
                acc,
                ExtensionTarget::from_range(row, ReducingGate::<D>::wires_old_acc()),
            );
            for (&t, c) in chunk.iter().zip(gate.wires_coeffs()) {
                builder.connect(t, Target::wire(row, c));
            }

            acc = ExtensionTarget::from_range(row, ReducingGate::<D>::wires_output());
        }

        acc
    }

    /// Reduces a vector of `ExtensionTarget`s using `ReducingExtensionGate`s.
    pub fn reduce<F>(
        &mut self,
        terms: &[ExtensionTarget<D>], // Could probably work with a `DoubleEndedIterator` too.
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>
    where
        F: RichField + Extendable<D>,
    {
        let l = terms.len();

        // For small reductions, use an arithmetic gate.
        if l <= ArithmeticExtensionGate::<D>::new_from_config(&builder.config).num_ops + 1 {
            return self.reduce_arithmetic(terms, builder);
        }

        let max_coeffs_len = ReducingExtensionGate::<D>::max_coeffs_len(
            builder.config.num_wires,
            builder.config.num_routed_wires,
        );
        self.count += l as u64;
        let zero_ext = builder.zero_extension();
        let mut acc = zero_ext;
        let mut reversed_terms = terms.to_vec();
        while reversed_terms.len() % max_coeffs_len != 0 {
            reversed_terms.push(zero_ext);
        }
        reversed_terms.reverse();
        for chunk in reversed_terms.chunks_exact(max_coeffs_len) {
            let gate = ReducingExtensionGate::new(max_coeffs_len);
            let row = builder.add_gate(gate.clone(), vec![]);

            builder.connect_extension(
                self.base,
                ExtensionTarget::from_range(row, ReducingExtensionGate::<D>::wires_alpha()),
            );
            builder.connect_extension(
                acc,
                ExtensionTarget::from_range(row, ReducingExtensionGate::<D>::wires_old_acc()),
            );
            for (i, &t) in chunk.iter().enumerate() {
                builder.connect_extension(
                    t,
                    ExtensionTarget::from_range(row, ReducingExtensionGate::<D>::wires_coeff(i)),
                );
            }

            acc = ExtensionTarget::from_range(row, ReducingExtensionGate::<D>::wires_output());
        }

        acc
    }

    /// Reduces a vector of `ExtensionTarget`s using `ArithmeticGate`s.
    fn reduce_arithmetic<F>(
        &mut self,
        terms: &[ExtensionTarget<D>],
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>
    where
        F: RichField + Extendable<D>,
    {
        self.count += terms.len() as u64;
        terms
            .iter()
            .rev()
            .fold(builder.zero_extension(), |acc, &et| {
                builder.mul_add_extension(self.base, acc, et)
            })
    }

    pub fn shift<F>(
        &mut self,
        x: ExtensionTarget<D>,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>
    where
        F: RichField + Extendable<D>,
    {
        let zero_ext = builder.zero_extension();
        let exp = if x == zero_ext {
            // The result will get zeroed out, so don't actually compute the exponentiation.
            zero_ext
        } else {
            builder.exp_u64_extension(self.base, self.count)
        };

        self.count = 0;
        builder.mul_extension(exp, x)
    }

    pub fn reset(&mut self) {
        self.count = 0;
    }
}

#[cfg(test)]
#[cfg(feature = "rand")]
mod tests {
    use anyhow::Result;

    use super::*;
    use crate::field::types::{Field, Sample};
    use crate::iop::witness::{PartialWitness, WitnessWrite};
    use crate::plonk::circuit_data::CircuitConfig;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::plonk::verifier::verify;

    fn test_reduce_gadget_base(n: usize) -> Result<()> {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type FF = <C as GenericConfig<D>>::FE;

        let config = CircuitConfig::standard_recursion_config();

        let mut pw = PartialWitness::new();
        let mut builder = CircuitBuilder::<F, D>::new(config);

        let alpha = FF::rand();
        let vs = F::rand_vec(n);

        let manual_reduce = ReducingFactor::new(alpha).reduce(vs.iter().map(|&v| FF::from(v)));
        let manual_reduce = builder.constant_extension(manual_reduce);

        let mut alpha_t = ReducingFactorTarget::new(builder.constant_extension(alpha));
        let vs_t = builder.add_virtual_targets(vs.len());
        for (&v, &v_t) in vs.iter().zip(&vs_t) {
            pw.set_target(v_t, v)?;
        }
        let circuit_reduce = alpha_t.reduce_base(&vs_t, &mut builder);

        builder.connect_extension(manual_reduce, circuit_reduce);

        let data = builder.build::<C>();
        let proof = data.prove(pw)?;

        verify(proof, &data.verifier_only, &data.common)
    }

    fn test_reduce_gadget(n: usize) -> Result<()> {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type FF = <C as GenericConfig<D>>::FE;

        let config = CircuitConfig::standard_recursion_config();

        let mut pw = PartialWitness::new();
        let mut builder = CircuitBuilder::<F, D>::new(config);

        let alpha = FF::rand();
        let vs = (0..n).map(FF::from_canonical_usize).collect::<Vec<_>>();

        let manual_reduce = ReducingFactor::new(alpha).reduce(vs.iter());
        let manual_reduce = builder.constant_extension(manual_reduce);

        let mut alpha_t = ReducingFactorTarget::new(builder.constant_extension(alpha));
        let vs_t = builder.add_virtual_extension_targets(vs.len());
        pw.set_extension_targets(&vs_t, &vs)?;
        let circuit_reduce = alpha_t.reduce(&vs_t, &mut builder);

        builder.connect_extension(manual_reduce, circuit_reduce);

        let data = builder.build::<C>();
        let proof = data.prove(pw)?;

        verify(proof, &data.verifier_only, &data.common)
    }

    #[test]
    fn test_reduce_gadget_even() -> Result<()> {
        test_reduce_gadget(10)
    }

    #[test]
    fn test_reduce_gadget_odd() -> Result<()> {
        test_reduce_gadget(11)
    }

    #[test]
    fn test_reduce_gadget_base_100() -> Result<()> {
        test_reduce_gadget_base(100)
    }

    #[test]
    fn test_reduce_gadget_100() -> Result<()> {
        test_reduce_gadget(100)
    }
}
