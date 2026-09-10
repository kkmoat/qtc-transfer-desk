//! Implementation of the Poseidon hash function, as described in
//! <https://eprint.iacr.org/2019/458.pdf>
//!
//! This module re-exports core Poseidon types and adds circuit-building extensions.

#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

// Re-export all poseidon types from core
pub use qp_plonky2_core::poseidon::{
    Permuter, Poseidon, PoseidonHash, PoseidonPermutation, ALL_ROUND_CONSTANTS, HALF_N_FULL_ROUNDS,
    N_FULL_ROUNDS_TOTAL, N_PARTIAL_ROUNDS, N_ROUNDS, SPONGE_CAPACITY, SPONGE_RATE, SPONGE_WIDTH,
};

use crate::field::extension::Extendable;
use crate::field::types::Field;
use crate::gates::gate::Gate;
use crate::gates::poseidon::PoseidonGate;
use crate::gates::poseidon_mds::PoseidonMdsGate;
use crate::hash::hash_types::RichField;
use crate::hash::hashing::PlonkyPermutation;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::{BoolTarget, Target};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::AlgebraicHasher;

/// Extension trait that adds circuit-building methods to types implementing `Poseidon`.
/// These methods are used for in-circuit hashing and are specific to the prover.
pub trait PoseidonCircuit: Poseidon {
    fn mds_row_shf_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        r: usize,
        v: &[ExtensionTarget<D>; SPONGE_WIDTH],
    ) -> ExtensionTarget<D>
    where
        Self: RichField + Extendable<D>,
    {
        debug_assert!(r < SPONGE_WIDTH);
        let mut res = builder.zero_extension();

        for i in 0..SPONGE_WIDTH {
            let c = Self::from_canonical_u64(<Self as Poseidon>::MDS_MATRIX_CIRC[i]);
            res = builder.mul_const_add_extension(c, v[(i + r) % SPONGE_WIDTH], res);
        }
        {
            let c = Self::from_canonical_u64(<Self as Poseidon>::MDS_MATRIX_DIAG[r]);
            res = builder.mul_const_add_extension(c, v[r], res);
        }

        res
    }

    /// Recursive version of `mds_layer`.
    fn mds_layer_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &[ExtensionTarget<D>; SPONGE_WIDTH],
    ) -> [ExtensionTarget<D>; SPONGE_WIDTH]
    where
        Self: RichField + Extendable<D>,
    {
        // If we have enough routed wires, we will use PoseidonMdsGate.
        let mds_gate = PoseidonMdsGate::<Self, D>::new();
        if builder.config.num_routed_wires >= mds_gate.num_wires() {
            let index = builder.add_gate(mds_gate, vec![]);
            for i in 0..SPONGE_WIDTH {
                let input_wire = PoseidonMdsGate::<Self, D>::wires_input(i);
                builder.connect_extension(state[i], ExtensionTarget::from_range(index, input_wire));
            }
            (0..SPONGE_WIDTH)
                .map(|i| {
                    let output_wire = PoseidonMdsGate::<Self, D>::wires_output(i);
                    ExtensionTarget::from_range(index, output_wire)
                })
                .collect::<Vec<_>>()
                .try_into()
                .unwrap()
        } else {
            let mut result = [builder.zero_extension(); SPONGE_WIDTH];

            for r in 0..SPONGE_WIDTH {
                result[r] = Self::mds_row_shf_circuit(builder, r, state);
            }

            result
        }
    }

    /// Recursive version of `partial_first_constant_layer`.
    fn partial_first_constant_layer_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &mut [ExtensionTarget<D>; SPONGE_WIDTH],
    ) where
        Self: RichField + Extendable<D>,
    {
        for i in 0..SPONGE_WIDTH {
            let c = <Self as Poseidon>::FAST_PARTIAL_FIRST_ROUND_CONSTANT[i];
            let c = Self::Extension::from_canonical_u64(c);
            let c = builder.constant_extension(c);
            state[i] = builder.add_extension(state[i], c);
        }
    }

    /// Recursive version of `mds_partial_layer_init`.
    fn mds_partial_layer_init_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &[ExtensionTarget<D>; SPONGE_WIDTH],
    ) -> [ExtensionTarget<D>; SPONGE_WIDTH]
    where
        Self: RichField + Extendable<D>,
    {
        let mut result = [builder.zero_extension(); SPONGE_WIDTH];

        result[0] = state[0];

        for r in 1..SPONGE_WIDTH {
            for c in 1..SPONGE_WIDTH {
                let t = <Self as Poseidon>::FAST_PARTIAL_ROUND_INITIAL_MATRIX[r - 1][c - 1];
                let t = Self::Extension::from_canonical_u64(t);
                let t = builder.constant_extension(t);
                result[c] = builder.mul_add_extension(t, state[r], result[c]);
            }
        }
        result
    }

    /// Recursive version of `mds_partial_layer_fast`.
    fn mds_partial_layer_fast_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &[ExtensionTarget<D>; SPONGE_WIDTH],
        r: usize,
    ) -> [ExtensionTarget<D>; SPONGE_WIDTH]
    where
        Self: RichField + Extendable<D>,
    {
        let s0 = state[0];
        let mds0to0 = Self::MDS_MATRIX_CIRC[0] + Self::MDS_MATRIX_DIAG[0];
        let mut d = builder.mul_const_extension(Self::from_canonical_u64(mds0to0), s0);
        for i in 1..SPONGE_WIDTH {
            let t = <Self as Poseidon>::FAST_PARTIAL_ROUND_W_HATS[r][i - 1];
            let t = Self::Extension::from_canonical_u64(t);
            let t = builder.constant_extension(t);
            d = builder.mul_add_extension(t, state[i], d);
        }

        let mut result = [builder.zero_extension(); SPONGE_WIDTH];
        result[0] = d;
        for i in 1..SPONGE_WIDTH {
            let t = <Self as Poseidon>::FAST_PARTIAL_ROUND_VS[r][i - 1];
            let t = Self::Extension::from_canonical_u64(t);
            let t = builder.constant_extension(t);
            result[i] = builder.mul_add_extension(t, state[0], state[i]);
        }
        result
    }

    /// Recursive version of `constant_layer`.
    fn constant_layer_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &mut [ExtensionTarget<D>; SPONGE_WIDTH],
        round_ctr: usize,
    ) where
        Self: RichField + Extendable<D>,
    {
        for i in 0..SPONGE_WIDTH {
            let c = ALL_ROUND_CONSTANTS[i + SPONGE_WIDTH * round_ctr];
            let c = Self::Extension::from_canonical_u64(c);
            let c = builder.constant_extension(c);
            state[i] = builder.add_extension(state[i], c);
        }
    }

    /// Recursive version of `sbox_monomial`.
    fn sbox_monomial_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        x: ExtensionTarget<D>,
    ) -> ExtensionTarget<D>
    where
        Self: RichField + Extendable<D>,
    {
        // x |--> x^7
        builder.exp_u64_extension(x, 7)
    }

    /// Recursive version of `sbox_layer`.
    fn sbox_layer_circuit<const D: usize>(
        builder: &mut CircuitBuilder<Self, D>,
        state: &mut [ExtensionTarget<D>; SPONGE_WIDTH],
    ) where
        Self: RichField + Extendable<D>,
    {
        for i in 0..SPONGE_WIDTH {
            state[i] = <Self as PoseidonCircuit>::sbox_monomial_circuit(builder, state[i]);
        }
    }
}

// Blanket implementation: any type implementing Poseidon automatically gets PoseidonCircuit
impl<T: Poseidon> PoseidonCircuit for T {}

// Implement AlgebraicHasher for PoseidonHash (circuit-building extension)
impl<F: RichField> AlgebraicHasher<F> for PoseidonHash {
    type AlgebraicPermutation = PoseidonPermutation<Target>;

    fn permute_swapped<const D: usize>(
        inputs: Self::AlgebraicPermutation,
        swap: BoolTarget,
        builder: &mut CircuitBuilder<F, D>,
    ) -> Self::AlgebraicPermutation
    where
        F: RichField + Extendable<D>,
    {
        let gate_type = PoseidonGate::<F, D>::new();
        let gate = builder.add_gate(gate_type, vec![]);

        let swap_wire = PoseidonGate::<F, D>::WIRE_SWAP;
        let swap_wire = Target::wire(gate, swap_wire);
        builder.connect(swap.target, swap_wire);

        // Route input wires.
        let inputs = inputs.as_ref();
        for i in 0..SPONGE_WIDTH {
            let in_wire = PoseidonGate::<F, D>::wire_input(i);
            let in_wire = Target::wire(gate, in_wire);
            builder.connect(inputs[i], in_wire);
        }

        // Collect output wires.
        Self::AlgebraicPermutation::new(
            (0..SPONGE_WIDTH).map(|i| Target::wire(gate, PoseidonGate::<F, D>::wire_output(i))),
        )
    }
}
