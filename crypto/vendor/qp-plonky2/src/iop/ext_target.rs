//! Extension field target types for recursive verification.
//!
//! Re-exports base types from qp-plonky2-core and adds CircuitBuilder methods.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

// Re-export base types from core
pub use qp_plonky2_core::{
    flatten_target, unflatten_target, ExtensionAlgebraTarget, ExtensionTarget,
};

use crate::field::extension::algebra::ExtensionAlgebra;
use crate::field::extension::{Extendable, FieldExtension, OEF};
use crate::field::types::Field;
use crate::hash::hash_types::RichField;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;

/// Extension trait for ExtensionTarget with methods requiring CircuitBuilder.
pub trait ExtensionTargetFrobenius<const D: usize> {
    fn frobenius<F: RichField + Extendable<D>>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>;

    fn repeated_frobenius<F: RichField + Extendable<D>>(
        &self,
        count: usize,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D>;
}

impl<const D: usize> ExtensionTargetFrobenius<D> for ExtensionTarget<D> {
    fn frobenius<F: RichField + Extendable<D>>(
        &self,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D> {
        self.repeated_frobenius(1, builder)
    }

    fn repeated_frobenius<F: RichField + Extendable<D>>(
        &self,
        count: usize,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D> {
        if count == 0 {
            return *self;
        } else if count >= D {
            return self.repeated_frobenius(count % D, builder);
        }
        let arr = self.to_target_array();
        let k = (F::order() - 1u32) / (D as u64);
        let z0 = F::Extension::W.exp_biguint(&(k * count as u64));
        #[allow(clippy::needless_collect)]
        let zs = z0
            .powers()
            .take(D)
            .map(|z| builder.constant(z))
            .collect::<Vec<_>>();

        let mut res = Vec::with_capacity(D);
        for (z, a) in zs.into_iter().zip(arr) {
            res.push(builder.mul(z, a));
        }

        res.try_into().unwrap()
    }
}

// CircuitBuilder extension methods for extension targets
impl<F: RichField + Extendable<D>, const D: usize> CircuitBuilder<F, D> {
    pub fn constant_extension(&mut self, c: F::Extension) -> ExtensionTarget<D> {
        let c_parts = c.to_basefield_array();
        let mut parts = [self.zero(); D];
        for i in 0..D {
            parts[i] = self.constant(c_parts[i]);
        }
        ExtensionTarget(parts)
    }

    pub fn constant_ext_algebra(
        &mut self,
        c: ExtensionAlgebra<F::Extension, D>,
    ) -> ExtensionAlgebraTarget<D> {
        let c_parts = c.to_basefield_array();
        let mut parts = [self.zero_extension(); D];
        for i in 0..D {
            parts[i] = self.constant_extension(c_parts[i]);
        }
        ExtensionAlgebraTarget(parts)
    }

    pub fn zero_extension(&mut self) -> ExtensionTarget<D> {
        self.constant_extension(F::Extension::ZERO)
    }

    pub fn one_extension(&mut self) -> ExtensionTarget<D> {
        self.constant_extension(F::Extension::ONE)
    }

    pub fn two_extension(&mut self) -> ExtensionTarget<D> {
        self.constant_extension(F::Extension::TWO)
    }

    pub fn neg_one_extension(&mut self) -> ExtensionTarget<D> {
        self.constant_extension(F::Extension::NEG_ONE)
    }

    pub fn zero_ext_algebra(&mut self) -> ExtensionAlgebraTarget<D> {
        self.constant_ext_algebra(ExtensionAlgebra::ZERO)
    }

    pub fn convert_to_ext(&mut self, t: Target) -> ExtensionTarget<D> {
        let zero = self.zero();
        t.to_ext_target(zero)
    }

    pub fn convert_to_ext_algebra(&mut self, et: ExtensionTarget<D>) -> ExtensionAlgebraTarget<D> {
        let zero = self.zero_extension();
        let mut arr = [zero; D];
        arr[0] = et;
        ExtensionAlgebraTarget(arr)
    }
}
