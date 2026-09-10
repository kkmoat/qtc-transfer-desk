#[cfg(not(feature = "std"))]
use alloc::{
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};
use core::marker::PhantomData;

use anyhow::Result;

use crate::field::extension::algebra::ExtensionAlgebra;
use crate::field::extension::{Extendable, FieldExtension};
use crate::field::types::Field;
use crate::gates::gate::Gate;
use crate::gates::poseidon2::SPONGE_WIDTH;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::{ExtensionAlgebraTarget, ExtensionTarget};
use crate::iop::generator::{GeneratedValues, SimpleGenerator, WitnessGeneratorRef};
use crate::iop::target::Target;
use crate::iop::witness::{PartitionWitness, Witness, WitnessWrite};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationTargets, EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// Poseidon2 light-MDS Gate (width = SPONGE_WIDTH).
///
/// This enforces one *light* MDS layer:
///   1. Apply the 4×4 matrix to each block of 4 elements (3 blocks total).
///   2. Add the column sums across the 3 blocks to each element in that column.
#[derive(Debug, Default)]
pub struct Poseidon2MdsGate<F: RichField + Extendable<D>, const D: usize>(PhantomData<F>);

impl<F: RichField + Extendable<D>, const D: usize> Poseidon2MdsGate<F, D> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }

    pub(crate) const fn wires_input(i: usize) -> core::ops::Range<usize> {
        assert!(i < SPONGE_WIDTH);
        i * D..(i + 1) * D
    }

    pub(crate) const fn wires_output(i: usize) -> core::ops::Range<usize> {
        assert!(i < SPONGE_WIDTH);
        (SPONGE_WIDTH + i) * D..(SPONGE_WIDTH + i + 1) * D
    }

    /// Light-MDS on extension field elements (for `eval_unfiltered_base_one`).
    fn mds_light_field<T: Field>(state: &[T; SPONGE_WIDTH]) -> [T; SPONGE_WIDTH] {
        let two = T::from_canonical_u64(2);
        let three = T::from_canonical_u64(3);

        let mut tmp = [T::ZERO; SPONGE_WIDTH];

        // 3 blocks of size 4: [0..4), [4..8), [8..12)
        for k in (0..SPONGE_WIDTH).step_by(4) {
            let a = state[k];
            let x = state[k + 1];
            let c = state[k + 2];
            let d = state[k + 3];

            // Standard 4×4 Poseidon2 light MDS matrix:
            //
            // [2 3 1 1]
            // [1 2 3 1]
            // [1 1 2 3]
            // [3 1 1 2]
            tmp[k] = a * two + x * three + c + d;
            tmp[k + 1] = a + x * two + c * three + d;
            tmp[k + 2] = a + x + c * two + d * three;
            tmp[k + 3] = a * three + x + c + d * two;
        }

        // Column sums across the three blocks.
        let mut sums = [T::ZERO; 4];
        for i in 0..4 {
            sums[i] = tmp[i] + tmp[4 + i] + tmp[8 + i];
        }

        // Add sums to each lane based on its column index mod 4.
        let mut out = [T::ZERO; SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            out[i] = tmp[i] + sums[i % 4];
        }

        out
    }

    /// Light-MDS on extension algebra elements (for `eval_unfiltered`).
    fn mds_light_algebra(
        state: &[ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH],
    ) -> [ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH] {
        let two = F::Extension::from_canonical_u64(2);
        let three = F::Extension::from_canonical_u64(3);

        let mut tmp = [ExtensionAlgebra::ZERO; SPONGE_WIDTH];

        for k in (0..SPONGE_WIDTH).step_by(4) {
            let a = state[k];
            let x = state[k + 1];
            let c = state[k + 2];
            let d = state[k + 3];

            tmp[k] = a.scalar_mul(two) + x.scalar_mul(three) + c + d;
            tmp[k + 1] = a + x.scalar_mul(two) + c.scalar_mul(three) + d;
            tmp[k + 2] = a + x + c.scalar_mul(two) + d.scalar_mul(three);
            tmp[k + 3] = a.scalar_mul(three) + x + c + d.scalar_mul(two);
        }

        let mut sums = [ExtensionAlgebra::ZERO; 4];
        for i in 0..4 {
            sums[i] = tmp[i] + tmp[4 + i] + tmp[8 + i];
        }

        let mut out = [ExtensionAlgebra::ZERO; SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            out[i] = tmp[i] + sums[i % 4];
        }

        out
    }

    /// Light-MDS on extension algebra *targets* (for `eval_unfiltered_circuit`).
    fn mds_light_algebra_circuit(
        builder: &mut CircuitBuilder<F, D>,
        state: &[ExtensionAlgebraTarget<D>; SPONGE_WIDTH],
    ) -> [ExtensionAlgebraTarget<D>; SPONGE_WIDTH] {
        let two = builder.constant_extension(F::Extension::from_canonical_u64(2));
        let three = builder.constant_extension(F::Extension::from_canonical_u64(3));
        let one = builder.constant_extension(F::Extension::from_canonical_u64(1));

        let mut tmp = [builder.zero_ext_algebra(); SPONGE_WIDTH];

        for k in (0..SPONGE_WIDTH).step_by(4) {
            let a = state[k];
            let x = state[k + 1];
            let c = state[k + 2];
            let d = state[k + 3];

            // y0 = 2a + 3x + c + d
            let mut y0 = builder.zero_ext_algebra();
            y0 = builder.scalar_mul_add_ext_algebra(two, a, y0);
            y0 = builder.scalar_mul_add_ext_algebra(three, x, y0);
            y0 = builder.scalar_mul_add_ext_algebra(one, c, y0);
            y0 = builder.scalar_mul_add_ext_algebra(one, d, y0);

            // y1 = a + 2x + 3c + d
            let mut y1 = builder.zero_ext_algebra();
            y1 = builder.scalar_mul_add_ext_algebra(one, a, y1);
            y1 = builder.scalar_mul_add_ext_algebra(two, x, y1);
            y1 = builder.scalar_mul_add_ext_algebra(three, c, y1);
            y1 = builder.scalar_mul_add_ext_algebra(one, d, y1);

            // y2 = a + x + 2c + 3d
            let mut y2 = builder.zero_ext_algebra();
            y2 = builder.scalar_mul_add_ext_algebra(one, a, y2);
            y2 = builder.scalar_mul_add_ext_algebra(one, x, y2);
            y2 = builder.scalar_mul_add_ext_algebra(two, c, y2);
            y2 = builder.scalar_mul_add_ext_algebra(three, d, y2);

            // y3 = 3a + x + c + 2d
            let mut y3 = builder.zero_ext_algebra();
            y3 = builder.scalar_mul_add_ext_algebra(three, a, y3);
            y3 = builder.scalar_mul_add_ext_algebra(one, x, y3);
            y3 = builder.scalar_mul_add_ext_algebra(one, c, y3);
            y3 = builder.scalar_mul_add_ext_algebra(two, d, y3);

            tmp[k] = y0;
            tmp[k + 1] = y1;
            tmp[k + 2] = y2;
            tmp[k + 3] = y3;
        }

        // Column sums (still in the algebra).
        let mut sums = [builder.zero_ext_algebra(); 4];
        for i in 0..4 {
            let mut acc = builder.zero_ext_algebra();
            acc = builder.add_ext_algebra(acc, tmp[i]);
            acc = builder.add_ext_algebra(acc, tmp[4 + i]);
            acc = builder.add_ext_algebra(acc, tmp[8 + i]);
            sums[i] = acc;
        }

        let mut out = [builder.zero_ext_algebra(); SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            out[i] = builder.add_ext_algebra(tmp[i], sums[i % 4]);
        }

        out
    }
}

impl<F: RichField + Extendable<D>, const D: usize> Gate<F, D> for Poseidon2MdsGate<F, D> {
    fn id(&self) -> String {
        format!("Poseidon2MdsGate<WIDTH={SPONGE_WIDTH}>")
    }

    fn serialize(
        &self,
        _dst: &mut Vec<u8>,
        _common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<()> {
        Ok(())
    }

    fn deserialize(_src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(Poseidon2MdsGate::new())
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = Self::mds_light_algebra(&inputs);

        (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_output(i)))
            .zip(computed_outputs)
            .flat_map(|(out, computed_out)| (out - computed_out).to_basefield_array())
            .collect()
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = Self::mds_light_field(&inputs);

        yield_constr.many(
            (0..SPONGE_WIDTH)
                .map(|i| vars.get_local_ext(Self::wires_output(i)))
                .zip(computed_outputs)
                .flat_map(|(out, computed_out)| (out - computed_out).to_basefield_array()),
        )
    }

    fn eval_unfiltered_circuit(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        vars: EvaluationTargets<D>,
    ) -> Vec<ExtensionTarget<D>> {
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = Self::mds_light_algebra_circuit(builder, &inputs);

        (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_output(i)))
            .zip(computed_outputs)
            .flat_map(|(out, computed_out)| {
                builder
                    .sub_ext_algebra(out, computed_out)
                    .to_ext_target_array()
            })
            .collect()
    }

    fn generators(&self, row: usize, _local_constants: &[F]) -> Vec<WitnessGeneratorRef<F, D>> {
        let gen = Poseidon2MdsGenerator::<D> { row };
        vec![WitnessGeneratorRef::new(gen.adapter())]
    }

    fn num_wires(&self) -> usize {
        2 * D * SPONGE_WIDTH
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        1
    }

    fn num_constraints(&self) -> usize {
        SPONGE_WIDTH * D
    }
}

#[derive(Clone, Debug, Default)]
pub struct Poseidon2MdsGenerator<const D: usize> {
    row: usize,
}

impl<F: RichField + Extendable<D>, const D: usize> SimpleGenerator<F, D>
    for Poseidon2MdsGenerator<D>
{
    fn id(&self) -> String {
        "Poseidon2MdsGenerator".to_string()
    }

    fn dependencies(&self) -> Vec<Target> {
        (0..SPONGE_WIDTH)
            .flat_map(|i| {
                Target::wires_from_range(self.row, Poseidon2MdsGate::<F, D>::wires_input(i))
            })
            .collect()
    }

    fn run_once(
        &self,
        witness: &PartitionWitness<F>,
        out_buffer: &mut GeneratedValues<F>,
    ) -> Result<()> {
        let get_local_get_target = |wire_range| ExtensionTarget::from_range(self.row, wire_range);
        let get_local_ext =
            |wire_range| witness.get_extension_target(get_local_get_target(wire_range));

        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| get_local_ext(Poseidon2MdsGate::<F, D>::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let outputs = Poseidon2MdsGate::<F, D>::mds_light_field(&inputs);

        for (i, &out) in outputs.iter().enumerate() {
            out_buffer.set_extension_target(
                get_local_get_target(Poseidon2MdsGate::<F, D>::wires_output(i)),
                out,
            )?;
        }

        Ok(())
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.row)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let row = src.read_usize()?;
        Ok(Self { row })
    }
}
