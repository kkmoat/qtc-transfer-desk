#[cfg(not(feature = "std"))]
use alloc::{
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};
use core::marker::PhantomData;
use core::ops::Range;

use anyhow::Result;
use qp_poseidon_core::poseidon2::{
    INITIAL_EXTERNAL_CONSTANTS, INTERNAL_CONSTANTS, TERMINAL_EXTERNAL_CONSTANTS,
};

use crate::field::extension::algebra::ExtensionAlgebra;
use crate::field::extension::{Extendable, FieldExtension};
use crate::field::types::Field;
use crate::gates::gate::Gate;
// Re-use constants from poseidon2 gate
use crate::gates::poseidon2::{Poseidon2Params, SPONGE_WIDTH};
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

/// Same formula as your existing helper:
/// y[i] = diag[i] * x[i] + sum_j x[j]
fn internal_mix_base<F: Field>(
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

#[derive(Clone, Debug, Default)]
pub struct Poseidon2IntMixGate<F: RichField + Extendable<D>, const D: usize> {
    /// diag in the base field F (same as Poseidon2Params.diag)
    diag: [F; SPONGE_WIDTH],
    _pd: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> Poseidon2IntMixGate<F, D> {
    pub fn new() -> Self {
        // Reuse Poseidon2Params to get diag; we ignore other fields.
        let params = Poseidon2Params::<F, D>::from_p3_constants_u64(
            INITIAL_EXTERNAL_CONSTANTS,
            TERMINAL_EXTERNAL_CONSTANTS,
            INTERNAL_CONSTANTS,
        );
        Self {
            diag: params.diag,
            _pd: PhantomData,
        }
    }

    pub(crate) const fn wires_input(i: usize) -> Range<usize> {
        assert!(i < SPONGE_WIDTH);
        i * D..(i + 1) * D
    }

    pub(crate) const fn wires_output(i: usize) -> Range<usize> {
        assert!(i < SPONGE_WIDTH);
        (SPONGE_WIDTH + i) * D..(SPONGE_WIDTH + i + 1) * D
    }

    /// Internal mix over an extension algebra of F::Extension
    fn internal_mix_algebra(
        &self,
        state: &[ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH],
    ) -> [ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH] {
        // Lift diag to F::Extension
        let diag_ext: [F::Extension; SPONGE_WIDTH] = core::array::from_fn(|i| {
            F::Extension::from_canonical_u64(self.diag[i].to_canonical_u64())
        });

        let mut sum = state[0];
        for i in 1..SPONGE_WIDTH {
            sum += state[i];
        }

        let mut out = [ExtensionAlgebra::ZERO; SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            let coeff = diag_ext[i];
            // coeff * state[i] + sum
            out[i] = state[i].scalar_mul(coeff) + sum;
        }
        out
    }

    /// Internal mix in the circuit over ExtensionAlgebraTargets
    fn internal_mix_algebra_circuit(
        &self,
        builder: &mut CircuitBuilder<F, D>,
        state: &[ExtensionAlgebraTarget<D>; SPONGE_WIDTH],
    ) -> [ExtensionAlgebraTarget<D>; SPONGE_WIDTH] {
        // diag as circuit constants in F::Extension
        let diag_ext: [ExtensionTarget<D>; SPONGE_WIDTH] = core::array::from_fn(|i| {
            let v = F::Extension::from_canonical_u64(self.diag[i].to_canonical_u64());
            builder.constant_extension(v)
        });

        // sum = sum_j state[j]
        let mut sum = state[0];
        for i in 1..SPONGE_WIDTH {
            sum = builder.add_ext_algebra(sum, state[i]);
        }

        // y[i] = diag[i] * state[i] + sum
        let mut out = [builder.zero_ext_algebra(); SPONGE_WIDTH];
        for i in 0..SPONGE_WIDTH {
            let mut acc = sum;
            acc = builder.scalar_mul_add_ext_algebra(diag_ext[i], state[i], acc);
            out[i] = acc;
        }

        out
    }
}

impl<F: RichField + Extendable<D>, const D: usize> Gate<F, D> for Poseidon2IntMixGate<F, D> {
    fn id(&self) -> String {
        format!("Poseidon2IntMixGate<WIDTH={SPONGE_WIDTH}>")
    }

    fn serialize(
        &self,
        _dst: &mut Vec<u8>,
        _common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<()> {
        Ok(())
    }

    fn deserialize(_src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(Self::new())
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        // inputs as extension algebra elements
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = self.internal_mix_algebra(&inputs);

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
        // Here we work in the base-one extension (F::Extension)
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        // diag lifted into F::Extension
        let diag_ext: [F::Extension; SPONGE_WIDTH] = core::array::from_fn(|i| {
            F::Extension::from_canonical_u64(self.diag[i].to_canonical_u64())
        });

        let computed_outputs = internal_mix_base::<F::Extension>(&inputs, &diag_ext);

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

        let computed_outputs = self.internal_mix_algebra_circuit(builder, &inputs);

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
        let gen = Poseidon2IntMixGenerator::<D> { row };
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
pub struct Poseidon2IntMixGenerator<const D: usize> {
    row: usize,
}

impl<F: RichField + Extendable<D>, const D: usize> SimpleGenerator<F, D>
    for Poseidon2IntMixGenerator<D>
{
    fn id(&self) -> String {
        "Poseidon2IntMixGenerator".to_string()
    }

    fn dependencies(&self) -> Vec<Target> {
        (0..SPONGE_WIDTH)
            .flat_map(|i| {
                Target::wires_from_range(self.row, Poseidon2IntMixGate::<F, D>::wires_input(i))
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
            .map(|i| get_local_ext(Poseidon2IntMixGate::<F, D>::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        // diag as F::Extension
        let params = Poseidon2Params::<F, D>::from_p3_constants_u64(
            INITIAL_EXTERNAL_CONSTANTS,
            TERMINAL_EXTERNAL_CONSTANTS,
            INTERNAL_CONSTANTS,
        );
        let diag_ext: [F::Extension; SPONGE_WIDTH] = core::array::from_fn(|i| {
            F::Extension::from_canonical_u64(params.diag[i].to_canonical_u64())
        });

        let outputs = internal_mix_base::<F::Extension>(&inputs, &diag_ext);

        for (i, &out) in outputs.iter().enumerate() {
            out_buffer.set_extension_target(
                get_local_get_target(Poseidon2IntMixGate::<F, D>::wires_output(i)),
                out,
            )?;
        }

        Ok(())
    }

    fn serialize(&self, dst: &mut Vec<u8>, _cd: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.row)
    }

    fn deserialize(src: &mut Buffer, _cd: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let row = src.read_usize()?;
        Ok(Self { row })
    }
}
