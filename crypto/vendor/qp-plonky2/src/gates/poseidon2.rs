#![allow(clippy::needless_range_loop)]

extern crate alloc;

#[cfg(not(feature = "std"))]
use alloc::format;
#[cfg(not(feature = "std"))]
use alloc::string::{String, ToString};
#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};
#[cfg(not(feature = "std"))]
use core::fmt::Debug;
use core::marker::PhantomData;

use plonky2_field::extension::Extendable;
use qp_poseidon_core::poseidon2::{
    EXTERNAL_ROUNDS as POSEIDON2_EXTERNAL_ROUNDS, INITIAL_EXTERNAL_CONSTANTS, INTERNAL_CONSTANTS,
    INTERNAL_ROUNDS as POSEIDON2_INTERNAL_ROUNDS, MATRIX_DIAG, TERMINAL_EXTERNAL_CONSTANTS,
};
// Re-export sponge parameters from qp-poseidon-core
pub use qp_poseidon_core::{POSEIDON2_OUTPUT, SPONGE_CAPACITY, SPONGE_RATE, SPONGE_WIDTH};
use unroll::unroll_for_loops;

use crate::field::types::Field;
use crate::gates::gate::Gate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::generator::{GeneratedValues, SimpleGenerator, WitnessGeneratorRef};
use crate::iop::target::Target;
use crate::iop::wire::Wire;
use crate::iop::witness::{PartitionWitness, Witness, WitnessWrite};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationTargets, EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// Poseidon2 over Goldilocks with `WIDTH = 12`, `RATE = 8` (capacity 4).
///
/// ## Structure (matches p3-goldilocks)
///
/// - **Initial preamble (once):**
///   - Apply the external light MDS (`mds_light_permutation`) to the 12-lane state.
///     This consists of applying the 4×4 matrix
///     ```text
///     [2 3 1 1]
///     [1 2 3 1]
///     [1 1 2 3]
///     [3 1 1 2]
///     ```
///     blockwise to lanes `(0..3), (4..7), (8..11)`, then adding the per-residue-class sums:
///     for each lane `i`, add `sum(state[j])` over all `j` with `j ≡ i (mod 4)`.
///
/// - **External rounds (initial and terminal, 4 each):**
///   For each round `r` and lane `i`:
///   1. Add round constant: ``state[i] = state[i] + rc_ext[phase][r][i]``.
///   2. Apply the S-box on **all lanes**: ``state[i] = state[i]^7``.
///   3. Apply the **light MDS** as in the preamble (same matrix + outer sums).
///
/// - **Internal rounds (22 total):**
///   For each round `r`:
///   1. Add round constant to **lane 0 only**, then apply the S-box on **lane 0 only**:
///      ```text
///      state[0] = (state[0] + rc_internal[r])^7
///      ```
///      Other lanes **do not** go through the S-box in internal rounds.
///   2. Apply the internal diffusion:
///      for each lane `i`,
///      ```text
///      state[i] = diag[i] * state[i] + sum(state)
///      ```
///      where `diag` is the fixed Goldilocks diagonal for `WIDTH=12`, and `sum(state)`
///      is the sum over all 12 lanes in the current state.
///
/// ## Notes
/// - All round constants are derived from the fixed seed used in p3-goldilocks, and the
///   diagonal matches `MATRIX_DIAG_12_GOLDILOCKS`.
/// - The only nonlinearity per internal round is the single `x^7` on lane 0, so each
///   internal-round gate’s constraint degree is 7.
/// - External rounds are also degree 7 (S-box on all lanes).

/// Constants (shared with CPU hashing).
#[derive(Clone, Debug, Default)]
pub struct Poseidon2Params<F: RichField + Extendable<D>, const D: usize> {
    /// 4 external rounds (initial phase), each a WIDTH-sized RC vector.
    pub ext_init: [[F; SPONGE_WIDTH]; 4],
    /// 4 external rounds (terminal phase), each a WIDTH-sized RC vector.
    pub ext_term: [[F; SPONGE_WIDTH]; 4],
    /// 22 internal round constants added to lane 0.
    pub int_rc: [F; POSEIDON2_INTERNAL_ROUNDS],
    /// Fixed GL diagonal used in the internal mixing.
    pub diag: [F; SPONGE_WIDTH],
}

impl<F: RichField + Extendable<D>, const D: usize> Poseidon2Params<F, D> {
    /// Create params from p3-style raw constants (as u64), exactly like your dump.
    pub fn from_p3_constants_u64(
        initial: [[u64; SPONGE_WIDTH]; 4],
        terminal: [[u64; SPONGE_WIDTH]; 4],
        internal: [u64; POSEIDON2_INTERNAL_ROUNDS],
    ) -> Self {
        // map helpers
        let map_u = |x: u64| F::from_canonical_u64(x);
        let map_rounds = |src: [[u64; SPONGE_WIDTH]; 4]| {
            core::array::from_fn::<[F; SPONGE_WIDTH], 4, _>(|r| {
                core::array::from_fn(|i| map_u(src[r][i]))
            })
        };

        let ext_init = map_rounds(initial);
        let ext_term = map_rounds(terminal);

        let mut int_rc = [F::ZERO; POSEIDON2_INTERNAL_ROUNDS];
        for i in 0..POSEIDON2_INTERNAL_ROUNDS {
            int_rc[i] = map_u(internal[i]);
        }

        // Goldilocks Poseidon2 diagonal from canonical constants
        let diag = core::array::from_fn(|i| F::from_canonical_u64(MATRIX_DIAG[i]));

        Self {
            ext_init,
            ext_term,
            int_rc,
            diag,
        }
    }
}

// ============================================================================
// Optimized helper functions using raw u64/u128 arithmetic
// These mirror the Poseidon2 trait methods but work with RichField directly
// ============================================================================

use crate::field::types::PrimeField64;

// `formal-export` re-exports these for `qp-plonky2-constraint-exporter` (see `../formal/PLAN.md` 3b).
#[inline(always)]
pub(crate) fn sbox7_base<F: Field>(x: F) -> F {
    let x2 = x.square();
    let x4 = x2.square();
    let x3 = x * x2;
    x3 * x4
}

/// Optimized light MDS using u128 accumulation to minimize reductions.
/// Returns a new state array.
#[inline(always)]
fn mds_light_optimized<F: PrimeField64>(state: &[F; SPONGE_WIDTH]) -> [F; SPONGE_WIDTH] {
    // Convert to raw u64
    let s: [u64; SPONGE_WIDTH] = core::array::from_fn(|i| state[i].to_noncanonical_u64());

    // Apply 4x4 blocks using u128 to defer reductions
    #[inline(always)]
    fn apply_mat4_u128(a: u64, b: u64, c: u64, d: u64) -> (u128, u128, u128, u128) {
        let t = (a as u128) + (b as u128) + (c as u128) + (d as u128);
        (
            t + (a as u128) + (b as u128) + (b as u128), // 2a + 3b + c + d
            t + (b as u128) + (c as u128) + (c as u128), // a + 2b + 3c + d
            t + (c as u128) + (d as u128) + (d as u128), // a + b + 2c + 3d
            t + (a as u128) + (a as u128) + (d as u128), // 3a + b + c + 2d
        )
    }

    let (y0, y1, y2, y3) = apply_mat4_u128(s[0], s[1], s[2], s[3]);
    let (y4, y5, y6, y7) = apply_mat4_u128(s[4], s[5], s[6], s[7]);
    let (y8, y9, y10, y11) = apply_mat4_u128(s[8], s[9], s[10], s[11]);

    // Compute sums per residue class (still in u128)
    let sum0 = y0 + y4 + y8;
    let sum1 = y1 + y5 + y9;
    let sum2 = y2 + y6 + y10;
    let sum3 = y3 + y7 + y11;

    // Final values and reduce
    [
        F::from_noncanonical_u128(y0 + sum0),
        F::from_noncanonical_u128(y1 + sum1),
        F::from_noncanonical_u128(y2 + sum2),
        F::from_noncanonical_u128(y3 + sum3),
        F::from_noncanonical_u128(y4 + sum0),
        F::from_noncanonical_u128(y5 + sum1),
        F::from_noncanonical_u128(y6 + sum2),
        F::from_noncanonical_u128(y7 + sum3),
        F::from_noncanonical_u128(y8 + sum0),
        F::from_noncanonical_u128(y9 + sum1),
        F::from_noncanonical_u128(y10 + sum2),
        F::from_noncanonical_u128(y11 + sum3),
    ]
}

/// Optimized internal mix using u128 accumulation.
#[inline(always)]
#[unroll_for_loops]
fn internal_mix_optimized<F: PrimeField64>(state: &[F; SPONGE_WIDTH]) -> [F; SPONGE_WIDTH] {
    // Convert to raw u64
    let s: [u64; SPONGE_WIDTH] = core::array::from_fn(|i| state[i].to_noncanonical_u64());

    // Compute sum in u128
    let mut sum = 0u128;
    for i in 0..12 {
        if i < SPONGE_WIDTH {
            sum += s[i] as u128;
        }
    }

    // Compute y[i] = diag[i] * s[i] + sum and reduce
    core::array::from_fn(|i| {
        let prod = (s[i] as u128) * (MATRIX_DIAG[i] as u128);
        F::from_noncanonical_u128(prod + sum)
    })
}

/// Apply S-box to all lanes using optimized squaring.
#[inline(always)]
#[unroll_for_loops]
fn sbox_layer_optimized<F: Field>(state: &mut [F; SPONGE_WIDTH]) {
    for i in 0..12 {
        if i < SPONGE_WIDTH {
            state[i] = sbox7_base(state[i]);
        }
    }
}

// Keep old functions for non-optimized paths (circuit evaluation, etc.)
#[inline(always)]
fn apply_mat4_base<F: Field>(a: F, b: F, c: F, d: F) -> [F; 4] {
    let t = a + b + c + d;
    let y0 = t + a + b + b;
    let y1 = t + b + c + c;
    let y2 = t + c + d + d;
    let y3 = t + a + a + d;
    [y0, y1, y2, y3]
}

#[inline(always)]
pub(crate) fn mds_light_base<F: Field>(s: &mut [F; SPONGE_WIDTH]) {
    let [y0, y1, y2, y3] = apply_mat4_base(s[0], s[1], s[2], s[3]);
    let [y4, y5, y6, y7] = apply_mat4_base(s[4], s[5], s[6], s[7]);
    let [y8, y9, y10, y11] = apply_mat4_base(s[8], s[9], s[10], s[11]);

    let sum0 = y0 + y4 + y8;
    let sum1 = y1 + y5 + y9;
    let sum2 = y2 + y6 + y10;
    let sum3 = y3 + y7 + y11;

    s[0] = y0 + sum0;
    s[1] = y1 + sum1;
    s[2] = y2 + sum2;
    s[3] = y3 + sum3;
    s[4] = y4 + sum0;
    s[5] = y5 + sum1;
    s[6] = y6 + sum2;
    s[7] = y7 + sum3;
    s[8] = y8 + sum0;
    s[9] = y9 + sum1;
    s[10] = y10 + sum2;
    s[11] = y11 + sum3;
}

fn mds_light_any<Fx: Field>(s: &mut [Fx; SPONGE_WIDTH]) {
    // identical to mds_light_base, just generic
    mds_light_base::<Fx>(s);
}

#[inline(always)]
fn apply_mat4_ext<F: RichField + Extendable<D>, const D: usize>(
    b: &mut CircuitBuilder<F, D>,
    a: ExtensionTarget<D>,
    x: ExtensionTarget<D>,
    c: ExtensionTarget<D>,
    d: ExtensionTarget<D>,
) -> [ExtensionTarget<D>; 4] {
    // y0 = 2a + 3x + 1c + 1d
    let two_a = b.add_extension(a, a);
    let two_x = b.add_extension(x, x);
    let three_x = b.add_extension(two_x, x);
    let t = b.add_extension(two_a, three_x);
    let t = b.add_extension(t, c);
    let y0 = b.add_extension(t, d);

    // y1 = 1a + 2x + 3c + 1d
    let two_c = b.add_extension(c, c);
    let three_c = b.add_extension(two_c, c);
    let two_x = b.add_extension(x, x);
    let two_x_plus_three_c = b.add_extension(two_x, three_c);
    let t = b.add_extension(a, two_x_plus_three_c);
    let y1 = b.add_extension(t, d);

    // y2 = 1a + 1x + 2c + 3d
    let two_d = b.add_extension(d, d);
    let three_d = b.add_extension(two_d, d);
    let two_c = b.add_extension(c, c);
    let two_c_plus_one_x = b.add_extension(two_c, x);
    let t = b.add_extension(a, two_c_plus_one_x);
    let y2 = b.add_extension(t, three_d);

    // y3 = 3a + 1x + 1c + 2d
    let three_a = b.add_extension(two_a, a);
    let one_x_plus_one_c = b.add_extension(x, c);
    let t = b.add_extension(three_a, one_x_plus_one_c);
    let two_d = b.add_extension(d, d);
    let y3 = b.add_extension(t, two_d);

    [y0, y1, y2, y3]
}

#[inline(always)]
fn mds_light_ext<F: RichField + Extendable<D>, const D: usize>(
    b: &mut CircuitBuilder<F, D>,
    s: &mut [ExtensionTarget<D>; SPONGE_WIDTH],
) {
    // 1) 4×4 per block with MDSMat4
    for k in (0..SPONGE_WIDTH).step_by(4) {
        let [y0, y1, y2, y3] = apply_mat4_ext::<F, D>(b, s[k], s[k + 1], s[k + 2], s[k + 3]);
        s[k] = y0;
        s[k + 1] = y1;
        s[k + 2] = y2;
        s[k + 3] = y3;
    }
    // 2) sums per residue class mod 4
    let mut sums = [b.zero_extension(); 4];
    for k in 0..4 {
        let t = b.add_extension(s[k], s[4 + k]);
        sums[k] = b.add_extension(t, s[8 + k]);
    }
    // 3) add sums[i%4]
    for i in 0..SPONGE_WIDTH {
        s[i] = b.add_extension(s[i], sums[i % 4]);
    }
}

#[inline(always)]
pub(crate) fn internal_mix_base<F: Field>(
    x: &[F; SPONGE_WIDTH],
    diag: &[F; SPONGE_WIDTH],
) -> [F; SPONGE_WIDTH] {
    let mut sum = x[0];
    for i in 1..SPONGE_WIDTH {
        sum += x[i];
    }
    let mut y = [F::ZERO; SPONGE_WIDTH];
    for i in 0..SPONGE_WIDTH {
        y[i] = diag[i] * x[i] + sum;
    }
    y
}

#[cfg(feature = "formal-export")]
#[doc(hidden)]
pub mod formal_export {
    use plonky2_field::types::Field;

    use super::{
        internal_mix_base as internal_mix_base_impl, mds_light_base as mds_light_base_impl,
        sbox7_base as sbox7_base_impl, SPONGE_WIDTH,
    };

    #[inline(always)]
    pub fn sbox7_base<F: Field>(x: F) -> F {
        sbox7_base_impl(x)
    }

    #[inline(always)]
    pub fn mds_light_base<F: Field>(s: &mut [F; SPONGE_WIDTH]) {
        mds_light_base_impl(s);
    }

    #[inline(always)]
    pub fn internal_mix_base<F: Field>(
        x: &[F; SPONGE_WIDTH],
        diag: &[F; SPONGE_WIDTH],
    ) -> [F; SPONGE_WIDTH] {
        internal_mix_base_impl(x, diag)
    }
}

#[inline(always)]
fn ext_c<Fx: RichField + Extendable<D>, const D: usize>(x: Fx) -> <Fx as Extendable<D>>::Extension {
    <<Fx as Extendable<D>>::Extension as Field>::from_canonical_u64(x.to_canonical_u64())
}

#[inline(always)]
fn sbox7_ext<Fx: RichField + Extendable<D>, const D: usize>(
    x: <Fx as Extendable<D>>::Extension,
) -> <Fx as Extendable<D>>::Extension {
    let x2 = x * x;
    let x4 = x2 * x2;
    (x * x2) * x4
}
fn sbox7_ext_circuit<F: RichField + Extendable<D>, const D: usize>(
    b: &mut CircuitBuilder<F, D>,
    x: ExtensionTarget<D>,
) -> ExtensionTarget<D> {
    let x2 = b.mul_extension(x, x);
    let x4 = b.mul_extension(x2, x2);
    let x3 = b.mul_extension(x, x2);
    b.mul_extension(x3, x4) // x^7
}

fn mds_light_circuit<F: RichField + Extendable<D>, const D: usize>(
    builder: &mut CircuitBuilder<F, D>,
    state: &mut [ExtensionTarget<D>; SPONGE_WIDTH],
) where
    F: RichField + Extendable<D>,
{
    // Note: Always use inline computation here instead of adding a gate.
    // Adding a Poseidon2MdsGate during eval_unfiltered_circuit causes issues:
    // the gate's generator conflicts with other generators when used in
    // recursive verification circuits.
    mds_light_ext::<F, D>(builder, state);
}

fn internal_mix_circuit<F: RichField + Extendable<D>, const D: usize>(
    builder: &mut CircuitBuilder<F, D>,
    state: &[ExtensionTarget<D>; SPONGE_WIDTH],
    diag: &[F; SPONGE_WIDTH],
) -> [ExtensionTarget<D>; SPONGE_WIDTH] {
    // Note: Always use inline computation here instead of adding a gate.
    // Adding a Poseidon2IntMixGate during eval_unfiltered_circuit causes issues:
    // the gate's generator conflicts with other generators when used in
    // recursive verification circuits.
    let mut s = *state;

    // diag as extension constants
    let diag_ext: [ExtensionTarget<D>; SPONGE_WIDTH] = core::array::from_fn(|i| {
        let val = ext_c::<F, D>(diag[i]);
        builder.constant_extension(val)
    });

    // sum = sum_j s[j]
    let mut sum = s[0];
    for i in 1..SPONGE_WIDTH {
        sum = builder.add_extension(sum, s[i]);
    }

    // y[i] = diag[i] * s[i] + sum
    for i in 0..SPONGE_WIDTH {
        s[i] = builder.mul_add_extension(diag_ext[i], s[i], sum);
    }

    s
}

#[derive(Clone, Debug)]
pub struct Poseidon2Gate<F: RichField + Extendable<D>, const D: usize> {
    params: Poseidon2Params<F, D>,
    _pd: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> Poseidon2Gate<F, D> {
    pub const W_IN: usize = 0;
    pub const W_OUT: usize = SPONGE_WIDTH;

    // S-box input wires for external (full) rounds.
    // Round 0 is elided (no checkpoint needed - state is degree-1), so we only
    // need wires for rounds 1-7 (7 rounds total).
    pub const W_EXT_SBOX: usize = 2 * SPONGE_WIDTH;

    // S-box input wires for internal rounds (lane 0 only)
    // Offset accounts for 7 external rounds (round 0 elided)
    pub const W_INT_SBOX: usize = Self::W_EXT_SBOX + (POSEIDON2_EXTERNAL_ROUNDS - 1) * SPONGE_WIDTH;

    pub const fn wire_input(i: usize) -> usize {
        Self::W_IN + i
    }
    pub const fn wire_output(i: usize) -> usize {
        Self::W_OUT + i
    }

    /// Returns the wire index for an external round S-box checkpoint.
    /// `round` is the logical round index (1-7), where round 0 is elided.
    #[inline]
    pub const fn wire_ext_sbox(round: usize, lane: usize) -> usize {
        debug_assert!(round > 0 && round < POSEIDON2_EXTERNAL_ROUNDS);
        debug_assert!(lane < SPONGE_WIDTH);
        // Subtract 1 from round since round 0 has no wires
        Self::W_EXT_SBOX + (round - 1) * SPONGE_WIDTH + lane
    }

    #[inline]
    pub const fn wire_int_sbox(round: usize) -> usize {
        debug_assert!(round < POSEIDON2_INTERNAL_ROUNDS);
        Self::W_INT_SBOX + round
    }

    pub const fn end() -> usize {
        // 12 in + 12 out + 7*12 external s-box inputs (round 0 elided) + 22 internal = 130
        Self::W_INT_SBOX + POSEIDON2_INTERNAL_ROUNDS
    }
    pub fn new() -> Self {
        Self {
            params: Poseidon2Params::from_p3_constants_u64(
                INITIAL_EXTERNAL_CONSTANTS,
                TERMINAL_EXTERNAL_CONSTANTS,
                INTERNAL_CONSTANTS,
            ),
            _pd: PhantomData,
        }
    }

    #[cfg(feature = "formal-export")]
    #[doc(hidden)]
    pub fn params(&self) -> &Poseidon2Params<F, D> {
        &self.params
    }
}

impl<F: RichField + Extendable<D>, const D: usize> Gate<F, D> for Poseidon2Gate<F, D> {
    fn id(&self) -> String {
        format!("Poseidon2Gate<WIDTH={SPONGE_WIDTH}>")
    }

    fn serialize(&self, _dst: &mut Vec<u8>, _cd: &CommonCircuitData<F, D>) -> IoResult<()> {
        Ok(())
    }

    fn deserialize(_src: &mut Buffer, _cd: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(Self::new())
    }

    fn num_wires(&self) -> usize {
        Self::end()
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn num_constraints(&self) -> usize {
        // One constraint per S-box input (external + internal), plus output equality.
        // Round 0 is elided: state is degree-1 (input wires through linear MDS preamble
        // + constants), so sbox7 produces degree 7 without a checkpoint.
        (POSEIDON2_EXTERNAL_ROUNDS - 1) * SPONGE_WIDTH + POSEIDON2_INTERNAL_ROUNDS + SPONGE_WIDTH
        // = 7*12 + 22 + 12 = 118
    }

    fn degree(&self) -> usize {
        7
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let lw = vars.local_wires;
        let mut constr = Vec::with_capacity(self.num_constraints());

        // 0) load inputs into extension state
        let mut state: [F::Extension; SPONGE_WIDTH] =
            core::array::from_fn(|i| lw[Self::wire_input(i)]);

        // 1) initial preamble (light MDS)
        mds_light_any::<F::Extension>(&mut state);

        let ext_init = &self.params.ext_init;
        let ext_term = &self.params.ext_term;
        let int_rc = &self.params.int_rc;
        let diag = &self.params.diag;

        let mut ext_round_idx = 0usize;

        // 2) 4 initial external rounds
        for r in 0..4 {
            // add RCs
            for i in 0..SPONGE_WIDTH {
                state[i] += ext_c::<F, D>(ext_init[r][i]);
            }
            // Round 0: state is degree-1 (input wires through linear
            // MDS preamble + constants), so sbox7 produces degree 7
            // without a checkpoint.
            if ext_round_idx != 0 {
                // constrain S-box inputs and update state = sbox_in
                for i in 0..SPONGE_WIDTH {
                    let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                    constr.push(state[i] - sbox_in);
                    state[i] = sbox_in;
                }
            }
            // apply S-box x^7 on all lanes
            for i in 0..SPONGE_WIDTH {
                state[i] = sbox7_ext::<F, D>(state[i]);
            }
            // light MDS
            mds_light_any::<F::Extension>(&mut state);
            ext_round_idx += 1;
        }

        // 3) 22 internal rounds (lane 0 sbox + internal mix)
        for r in 0..POSEIDON2_INTERNAL_ROUNDS {
            // lane 0: add RC
            state[0] += ext_c::<F, D>(int_rc[r]);

            // constrain S-box input for lane 0 and update
            let sbox_in = lw[Self::wire_int_sbox(r)];
            constr.push(state[0] - sbox_in);
            state[0] = sbox_in;
            state[0] = sbox7_ext::<F, D>(state[0]);

            // internal mixing: y[i] = diag[i]*x[i] + sum(x)
            let mut sum = state[0];
            for i in 1..SPONGE_WIDTH {
                sum += state[i];
            }
            for i in 0..SPONGE_WIDTH {
                let d_i = ext_c::<F, D>(diag[i]);
                state[i] = d_i * state[i] + sum;
            }
        }

        // 4) 4 terminal external rounds
        for r in 0..4 {
            // add RCs
            for i in 0..SPONGE_WIDTH {
                state[i] += ext_c::<F, D>(ext_term[r][i]);
            }
            // constrain S-box inputs and update state = sbox_in
            for i in 0..SPONGE_WIDTH {
                let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                constr.push(state[i] - sbox_in);
                state[i] = sbox_in;
            }
            // apply S-box x^7 on all lanes
            for i in 0..SPONGE_WIDTH {
                state[i] = sbox7_ext::<F, D>(state[i]);
            }
            mds_light_any::<F::Extension>(&mut state);
            ext_round_idx += 1;
        }

        // 5) outputs equal final state
        for i in 0..SPONGE_WIDTH {
            let out = lw[Self::wire_output(i)];
            constr.push(out - state[i]);
        }

        constr
    }

    fn eval_unfiltered_circuit(
        &self,
        b: &mut CircuitBuilder<F, D>,
        vars: EvaluationTargets<D>,
    ) -> Vec<ExtensionTarget<D>> {
        let lw = &vars.local_wires;
        let mut constr = Vec::with_capacity(self.num_constraints());

        // 0) load inputs
        let mut state: [ExtensionTarget<D>; SPONGE_WIDTH] =
            core::array::from_fn(|i| lw[Self::wire_input(i)]);

        // 1) preamble light MDS
        mds_light_circuit::<F, D>(b, &mut state);

        let ext_init = &self.params.ext_init;
        let ext_term = &self.params.ext_term;
        let int_rc = &self.params.int_rc;
        let diag = &self.params.diag;

        let mut ext_round_idx = 0usize;

        // 2) initial external rounds
        for r in 0..4 {
            // Hoist this round's RCs: one constant per lane
            let rc_row: [ExtensionTarget<D>; SPONGE_WIDTH] = core::array::from_fn(|i| {
                let val = ext_c::<F, D>(ext_init[r][i]);
                b.constant_extension(val)
            });

            // add RCs
            for i in 0..SPONGE_WIDTH {
                state[i] = b.add_extension(state[i], rc_row[i]);
            }

            // Round 0: state is degree-1 (input wires through linear
            // MDS preamble + constants), so sbox7 produces degree 7
            // without a checkpoint.
            if ext_round_idx != 0 {
                // constrain S-box inputs and update state = sbox_in
                for i in 0..SPONGE_WIDTH {
                    let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                    constr.push(b.sub_extension(state[i], sbox_in));
                    state[i] = sbox_in;
                }
            }

            // S-box x^7
            for i in 0..SPONGE_WIDTH {
                state[i] = sbox7_ext_circuit::<F, D>(b, state[i]);
            }

            mds_light_circuit::<F, D>(b, &mut state);
            ext_round_idx += 1;
        }

        // 3) internal rounds
        for r in 0..POSEIDON2_INTERNAL_ROUNDS {
            // lane 0 RC, hoisted once per round
            let rc0 = {
                let val = ext_c::<F, D>(int_rc[r]);
                b.constant_extension(val)
            };
            state[0] = b.add_extension(state[0], rc0);

            let sbox_in = lw[Self::wire_int_sbox(r)];
            constr.push(b.sub_extension(state[0], sbox_in));
            state[0] = sbox_in;
            state[0] = sbox7_ext_circuit::<F, D>(b, state[0]);

            // internal mixing via dedicated gate (or inline fallback)
            state = internal_mix_circuit::<F, D>(b, &state, diag);
        }

        // 4) terminal external rounds
        for r in 0..4 {
            // Hoist terminal RCs for this round
            let rc_row: [ExtensionTarget<D>; SPONGE_WIDTH] = core::array::from_fn(|i| {
                let val = ext_c::<F, D>(ext_term[r][i]);
                b.constant_extension(val)
            });

            // add RCs
            for i in 0..SPONGE_WIDTH {
                state[i] = b.add_extension(state[i], rc_row[i]);
            }

            // constrain S-box inputs
            for i in 0..SPONGE_WIDTH {
                let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                constr.push(b.sub_extension(state[i], sbox_in));
                state[i] = sbox_in;
            }

            // S-box x^7
            for i in 0..SPONGE_WIDTH {
                state[i] = sbox7_ext_circuit::<F, D>(b, state[i]);
            }

            mds_light_circuit::<F, D>(b, &mut state);
            ext_round_idx += 1;
        }

        // 5) outputs == state
        for i in 0..SPONGE_WIDTH {
            let out = lw[Self::wire_output(i)];
            constr.push(b.sub_extension(out, state[i]));
        }

        constr
    }

    #[unroll_for_loops]
    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let lw = vars.local_wires;

        // 0) load inputs into state
        let mut state: [F; SPONGE_WIDTH] = core::array::from_fn(|i| lw[Self::wire_input(i)]);

        // 1) initial preamble (light MDS) - use optimized u128 version
        state = mds_light_optimized(&state);

        let mut ext_round_idx = 0usize;

        // 2) 4 initial external rounds
        for r in 0..4 {
            // add RCs using raw u64 constants
            for i in 0..12 {
                if i < SPONGE_WIDTH {
                    // SAFETY: constants are canonical
                    state[i] =
                        unsafe { state[i].add_canonical_u64(INITIAL_EXTERNAL_CONSTANTS[r][i]) };
                }
            }

            // Round 0: state is degree-1, so sbox7 produces degree 7 without checkpoint
            if ext_round_idx != 0 {
                for i in 0..12 {
                    if i < SPONGE_WIDTH {
                        let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                        yield_constr.one(state[i] - sbox_in);
                        state[i] = sbox_in;
                    }
                }
            }

            // apply S-box x^7 on all lanes
            sbox_layer_optimized(&mut state);
            // light MDS - use optimized u128 version
            state = mds_light_optimized(&state);
            ext_round_idx += 1;
        }

        // 3) 22 internal rounds (lane 0 sbox + internal mix)
        for r in 0..22 {
            if r < POSEIDON2_INTERNAL_ROUNDS {
                // lane 0: add RC
                // SAFETY: constants are canonical
                state[0] = unsafe { state[0].add_canonical_u64(INTERNAL_CONSTANTS[r]) };

                // constrain S-box input for lane 0
                let sbox_in = lw[Self::wire_int_sbox(r)];
                yield_constr.one(state[0] - sbox_in);
                state[0] = sbox_in;
                state[0] = sbox7_base(state[0]);

                // internal mixing - use optimized u128 version
                state = internal_mix_optimized(&state);
            }
        }

        // 4) 4 terminal external rounds
        for r in 0..4 {
            // add RCs using raw u64 constants
            for i in 0..12 {
                if i < SPONGE_WIDTH {
                    // SAFETY: constants are canonical
                    state[i] =
                        unsafe { state[i].add_canonical_u64(TERMINAL_EXTERNAL_CONSTANTS[r][i]) };
                }
            }

            // constrain S-box inputs
            for i in 0..12 {
                if i < SPONGE_WIDTH {
                    let sbox_in = lw[Self::wire_ext_sbox(ext_round_idx, i)];
                    yield_constr.one(state[i] - sbox_in);
                    state[i] = sbox_in;
                }
            }

            // apply S-box x^7 on all lanes
            sbox_layer_optimized(&mut state);
            // light MDS - use optimized u128 version
            state = mds_light_optimized(&state);
            ext_round_idx += 1;
        }

        // 5) outputs equal final state
        for i in 0..12 {
            if i < SPONGE_WIDTH {
                let out = lw[Self::wire_output(i)];
                yield_constr.one(out - state[i]);
            }
        }
    }

    fn generators(&self, row: usize, _lc: &[F]) -> Vec<WitnessGeneratorRef<F, D>> {
        vec![WitnessGeneratorRef::new(
            Poseidon2FullGen::<F, D> {
                row,
                params: self.params.clone(),
                _pd: PhantomData,
            }
            .adapter(),
        )]
    }
}

#[derive(Clone, Debug, Default)]
pub struct Poseidon2FullGen<F: RichField + Extendable<D>, const D: usize> {
    row: usize,
    params: Poseidon2Params<F, D>,
    _pd: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> SimpleGenerator<F, D>
    for Poseidon2FullGen<F, D>
{
    fn id(&self) -> String {
        "Poseidon2FullGen".to_string()
    }

    fn dependencies(&self) -> Vec<Target> {
        // Only depends on the 12 inputs.
        (0..SPONGE_WIDTH)
            .map(|i| Target::wire(self.row, Poseidon2Gate::<F, D>::wire_input(i)))
            .collect()
    }

    fn run_once(
        &self,
        pw: &PartitionWitness<F>,
        out: &mut GeneratedValues<F>,
    ) -> anyhow::Result<()> {
        let mut state = [F::ZERO; SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            state[i] = pw.get_wire(Wire {
                row: self.row,
                column: Poseidon2Gate::<F, D>::wire_input(i),
            });
        }

        // 0) preamble MDS
        mds_light_base(&mut state);

        let ext_init = &self.params.ext_init;
        let ext_term = &self.params.ext_term;
        let int_rc = &self.params.int_rc;
        let diag = &self.params.diag;

        // ext_round_idx tracks the logical round (0-7), used to index wire_ext_sbox
        // which expects rounds 1-7 (round 0 is elided - no checkpoint wires).
        let mut ext_round_idx = 0usize;

        // 1) initial external rounds
        for r in 0..4 {
            for i in 0..SPONGE_WIDTH {
                state[i] = state[i] + ext_init[r][i];
                let s_in = state[i];
                // Round 0 has no checkpoint wires (state is degree-1, sbox7 gives degree-7)
                if ext_round_idx != 0 {
                    let idx = Poseidon2Gate::<F, D>::wire_ext_sbox(ext_round_idx, i);
                    out.set_wire(
                        Wire {
                            row: self.row,
                            column: idx,
                        },
                        s_in,
                    )?;
                }
                state[i] = sbox7_base(s_in);
            }
            mds_light_base(&mut state);
            ext_round_idx += 1;
        }

        // 2) internal rounds
        for r in 0..POSEIDON2_INTERNAL_ROUNDS {
            state[0] = state[0] + int_rc[r];
            let s_in = state[0];
            let idx = Poseidon2Gate::<F, D>::wire_int_sbox(r);
            out.set_wire(
                Wire {
                    row: self.row,
                    column: idx,
                },
                s_in,
            )?;
            state[0] = sbox7_base(s_in);
            state = internal_mix_base(&state, diag);
        }

        // 3) terminal external rounds
        for r in 0..4 {
            for i in 0..SPONGE_WIDTH {
                state[i] = state[i] + ext_term[r][i];
                let s_in = state[i];
                let idx = Poseidon2Gate::<F, D>::wire_ext_sbox(ext_round_idx, i);
                out.set_wire(
                    Wire {
                        row: self.row,
                        column: idx,
                    },
                    s_in,
                )?;
                state[i] = sbox7_base(s_in);
            }
            mds_light_base(&mut state);
            ext_round_idx += 1;
        }

        // 4) outputs
        for i in 0..SPONGE_WIDTH {
            out.set_wire(
                Wire {
                    row: self.row,
                    column: Poseidon2Gate::<F, D>::wire_output(i),
                },
                state[i],
            )?;
        }

        Ok(())
    }

    fn serialize(&self, dst: &mut Vec<u8>, _cd: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.row)
    }

    fn deserialize(src: &mut Buffer, _cd: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(Self {
            row: src.read_usize()?,
            params: Poseidon2Params::from_p3_constants_u64(
                INITIAL_EXTERNAL_CONSTANTS,
                TERMINAL_EXTERNAL_CONSTANTS,
                INTERNAL_CONSTANTS,
            ),
            _pd: PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use plonky2_field::goldilocks_field::GoldilocksField;
    use plonky2_field::types::Field64;

    use super::*;
    use crate::gates::gate::Gate;
    use crate::gates::poseidon::PoseidonGate;
    use crate::hash::hash_types::HashOut;
    use crate::plonk::vars::EvaluationVarsBaseBatch;

    #[test]
    fn test_num_constraints() {
        // Verify that num_constraints returns 118 after the round-0 S-box elision optimization.
        // Formula: (POSEIDON2_EXTERNAL_ROUNDS - 1) * SPONGE_WIDTH + POSEIDON2_INTERNAL_ROUNDS + SPONGE_WIDTH
        //        = (8 - 1) * 12 + 22 + 12 = 7 * 12 + 22 + 12 = 84 + 22 + 12 = 118
        type F = GoldilocksField;
        const D: usize = 2;
        let gate = Poseidon2Gate::<F, D>::new();
        assert_eq!(gate.num_constraints(), 118);
    }

    #[test]
    fn test_num_wires() {
        // Verify that num_wires returns 130 after removing round-0 checkpoint wires.
        // Formula: 12 in + 12 out + 7*12 external s-box (round 0 elided) + 22 internal
        //        = 12 + 12 + 84 + 22 = 130
        type F = GoldilocksField;
        const D: usize = 2;
        let gate = Poseidon2Gate::<F, D>::new();
        assert_eq!(gate.num_wires(), 130);
    }

    /// Verify that our optimized MDS and internal mix functions produce
    /// the same results as the p3 reference implementation.
    #[test]
    fn test_optimized_functions_match_p3_reference() {
        use plonky2_field::types::{Field, Field64};

        use crate::hash::poseidon2::P2Permuter;

        type F = GoldilocksField;

        // Test with various input patterns
        let test_cases: Vec<[F; SPONGE_WIDTH]> = vec![
            // All zeros
            [F::ZERO; SPONGE_WIDTH],
            // All ones
            [F::ONE; SPONGE_WIDTH],
            // Sequential values
            core::array::from_fn(|i| F::from_canonical_u64(i as u64)),
            // Large random-ish values (but valid canonical)
            core::array::from_fn(|i| {
                F::from_canonical_u64(
                    (0xDEADBEEF12345678_u64.wrapping_mul(i as u64 + 1)) % F::ORDER,
                )
            }),
            // Another pattern
            core::array::from_fn(|i| {
                F::from_canonical_u64(
                    (0x123456789ABCDEF0_u64.wrapping_add(i as u64 * 0x1111111111111111)) % F::ORDER,
                )
            }),
        ];

        for input in test_cases {
            // Compute using our optimized gate computation path
            // (simulates what eval_unfiltered_base_one does)
            let mut our_state = input;

            // Preamble MDS
            our_state = mds_light_optimized(&our_state);

            // 4 initial external rounds
            for r in 0..4 {
                for i in 0..SPONGE_WIDTH {
                    our_state[i] =
                        unsafe { our_state[i].add_canonical_u64(INITIAL_EXTERNAL_CONSTANTS[r][i]) };
                }
                sbox_layer_optimized(&mut our_state);
                our_state = mds_light_optimized(&our_state);
            }

            // 22 internal rounds
            for r in 0..POSEIDON2_INTERNAL_ROUNDS {
                our_state[0] = unsafe { our_state[0].add_canonical_u64(INTERNAL_CONSTANTS[r]) };
                our_state[0] = sbox7_base(our_state[0]);
                our_state = internal_mix_optimized(&our_state);
            }

            // 4 terminal external rounds
            for r in 0..4 {
                for i in 0..SPONGE_WIDTH {
                    our_state[i] = unsafe {
                        our_state[i].add_canonical_u64(TERMINAL_EXTERNAL_CONSTANTS[r][i])
                    };
                }
                sbox_layer_optimized(&mut our_state);
                our_state = mds_light_optimized(&our_state);
            }

            // Compute using p3 reference
            let p3_state = F::permute(input);

            // Compare
            for i in 0..SPONGE_WIDTH {
                assert_eq!(
                    our_state[i], p3_state[i],
                    "Mismatch at index {} for input {:?}",
                    i, input
                );
            }
        }
    }

    /// Benchmark comparing Poseidon1 vs Poseidon2 gate constraint evaluation.
    /// Run with: cargo test --release bench_gate_eval -- --nocapture --ignored
    #[test]
    #[ignore]
    fn bench_gate_eval() {
        type F = GoldilocksField;
        const D: usize = 2;

        let num_points = 1 << 14; // 16384 evaluation points
        let iterations = 100;

        let poseidon1_gate = PoseidonGate::<F, D>::new();
        let poseidon2_gate = Poseidon2Gate::<F, D>::new();

        let num_wires_1 = poseidon1_gate.num_wires();
        let num_wires_2 = poseidon2_gate.num_wires();

        println!(
            "PoseidonGate: {} wires, {} constraints",
            num_wires_1,
            poseidon1_gate.num_constraints()
        );
        println!(
            "Poseidon2Gate: {} wires, {} constraints",
            num_wires_2,
            poseidon2_gate.num_constraints()
        );

        // Generate wire values
        let wires_1: Vec<F> = (0..num_points * num_wires_1)
            .map(|i| F::from_canonical_u64((i as u64).wrapping_mul(12345678901234567) % F::ORDER))
            .collect();

        let wires_2: Vec<F> = (0..num_points * num_wires_2)
            .map(|i| F::from_canonical_u64((i as u64).wrapping_mul(12345678901234567) % F::ORDER))
            .collect();

        let constants: Vec<F> = vec![];
        let public_inputs_hash = HashOut::ZERO;

        // Benchmark Poseidon1
        let vars_batch_1 =
            EvaluationVarsBaseBatch::new(num_points, &constants, &wires_1, &public_inputs_hash);

        let start = std::time::Instant::now();
        for _ in 0..iterations {
            let _result = poseidon1_gate.eval_unfiltered_base_batch(vars_batch_1);
        }
        let elapsed_1 = start.elapsed();
        println!(
            "PoseidonGate:  {:?} for {} iterations ({:?} per iter)",
            elapsed_1,
            iterations,
            elapsed_1 / iterations
        );

        // Benchmark Poseidon2
        let vars_batch_2 =
            EvaluationVarsBaseBatch::new(num_points, &constants, &wires_2, &public_inputs_hash);

        let start = std::time::Instant::now();
        for _ in 0..iterations {
            let _result = poseidon2_gate.eval_unfiltered_base_batch(vars_batch_2);
        }
        let elapsed_2 = start.elapsed();
        println!(
            "Poseidon2Gate: {:?} for {} iterations ({:?} per iter)",
            elapsed_2,
            iterations,
            elapsed_2 / iterations
        );

        let ratio = elapsed_2.as_nanos() as f64 / elapsed_1.as_nanos() as f64;
        println!("\nPoseidon2/Poseidon1 ratio: {:.2}x", ratio);
    }

    /// Gate-level regression test for eval_unfiltered_base_batch.
    ///
    /// This test fills a valid Poseidon2Gate witness (all wires), calls
    /// eval_unfiltered_base_batch, and asserts all yielded constraints are zero.
    /// This directly tests the gate witness/checkpoint-wire constraint path.
    #[test]
    fn test_eval_unfiltered_base_batch_valid_witness() {
        use plonky2_field::types::Field;

        use crate::hash::poseidon2::P2Permuter;

        type F = GoldilocksField;
        const D: usize = 2;

        let gate = Poseidon2Gate::<F, D>::new();
        let num_wires = gate.num_wires();
        let num_constraints = gate.num_constraints();

        // Test with multiple input patterns
        let test_inputs: Vec<[F; SPONGE_WIDTH]> = vec![
            // All zeros
            [F::ZERO; SPONGE_WIDTH],
            // All ones
            [F::ONE; SPONGE_WIDTH],
            // Sequential values
            core::array::from_fn(|i| F::from_canonical_u64(i as u64 + 1)),
            // Large values
            core::array::from_fn(|i| {
                F::from_canonical_u64(0xDEADBEEF_u64.wrapping_mul(i as u64 + 1) % (1u64 << 63))
            }),
        ];

        for input in test_inputs {
            // Fill all wires correctly using the same logic as the witness generator
            let mut wires = vec![F::ZERO; num_wires];

            // Set input wires
            for i in 0..SPONGE_WIDTH {
                wires[Poseidon2Gate::<F, D>::wire_input(i)] = input[i];
            }

            // Run the permutation and fill checkpoint wires
            let mut state = input;

            // 0) preamble MDS
            mds_light_base(&mut state);

            let params = &gate.params;
            let ext_init = &params.ext_init;
            let ext_term = &params.ext_term;
            let int_rc = &params.int_rc;
            let diag = &params.diag;

            let mut ext_round_idx = 0usize;

            // 1) 4 initial external rounds
            for r in 0..4 {
                for i in 0..SPONGE_WIDTH {
                    state[i] = state[i] + ext_init[r][i];
                    let s_in = state[i];
                    // Round 0 has no checkpoint wires
                    if ext_round_idx != 0 {
                        wires[Poseidon2Gate::<F, D>::wire_ext_sbox(ext_round_idx, i)] = s_in;
                    }
                    state[i] = sbox7_base(s_in);
                }
                mds_light_base(&mut state);
                ext_round_idx += 1;
            }

            // 2) 22 internal rounds
            for r in 0..POSEIDON2_INTERNAL_ROUNDS {
                state[0] = state[0] + int_rc[r];
                let s_in = state[0];
                wires[Poseidon2Gate::<F, D>::wire_int_sbox(r)] = s_in;
                state[0] = sbox7_base(s_in);
                state = internal_mix_base(&state, diag);
            }

            // 3) 4 terminal external rounds
            for r in 0..4 {
                for i in 0..SPONGE_WIDTH {
                    state[i] = state[i] + ext_term[r][i];
                    let s_in = state[i];
                    wires[Poseidon2Gate::<F, D>::wire_ext_sbox(ext_round_idx, i)] = s_in;
                    state[i] = sbox7_base(s_in);
                }
                mds_light_base(&mut state);
                ext_round_idx += 1;
            }

            // 4) Set output wires
            for i in 0..SPONGE_WIDTH {
                wires[Poseidon2Gate::<F, D>::wire_output(i)] = state[i];
            }

            // Verify outputs match p3 reference
            let p3_output = F::permute(input);
            for i in 0..SPONGE_WIDTH {
                assert_eq!(
                    wires[Poseidon2Gate::<F, D>::wire_output(i)],
                    p3_output[i],
                    "Output mismatch at lane {} for input {:?}",
                    i,
                    input
                );
            }

            // Now call eval_unfiltered_base_batch and verify all constraints are zero
            let constants: Vec<F> = vec![];
            let public_inputs_hash = HashOut::ZERO;

            // Use batch size of 1 to test a single evaluation point
            let vars_batch =
                EvaluationVarsBaseBatch::new(1, &constants, &wires, &public_inputs_hash);

            // Collect constraint outputs
            let constraints = gate.eval_unfiltered_base_batch(vars_batch);

            // Assert we got the expected number of constraints
            assert_eq!(
                constraints.len(),
                num_constraints,
                "Wrong number of constraints returned"
            );

            // Assert all constraints are zero
            for (i, &c) in constraints.iter().enumerate() {
                assert_eq!(
                    c,
                    F::ZERO,
                    "Constraint {} is non-zero ({:?}) for input {:?}",
                    i,
                    c,
                    input
                );
            }
        }
    }
}
