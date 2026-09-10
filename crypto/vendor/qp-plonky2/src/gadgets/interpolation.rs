#[cfg(not(feature = "std"))]
use alloc::vec;

use plonky2_field::extension::Extendable;

use crate::gates::coset_interpolation::CosetInterpolationGate;
use crate::hash::hash_types::RichField;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;

impl<F: RichField + Extendable<D>, const D: usize> CircuitBuilder<F, D> {
    /// Interpolates a polynomial, whose points are a coset of the multiplicative subgroup with the
    /// given size, and whose values are given. Returns the evaluation of the interpolant at
    /// `evaluation_point`.
    pub(crate) fn interpolate_coset(
        &mut self,
        gate: CosetInterpolationGate<F, D>,
        coset_shift: Target,
        values: &[ExtensionTarget<D>],
        evaluation_point: ExtensionTarget<D>,
    ) -> ExtensionTarget<D> {
        let row = self.num_gates();
        self.connect(coset_shift, Target::wire(row, gate.wire_shift()));
        for (i, &v) in values.iter().enumerate() {
            self.connect_extension(v, ExtensionTarget::from_range(row, gate.wires_value(i)));
        }
        self.connect_extension(
            evaluation_point,
            ExtensionTarget::from_range(row, gate.wires_evaluation_point()),
        );

        let eval = ExtensionTarget::from_range(row, gate.wires_evaluation_value());
        self.add_gate(gate, vec![]);

        eval
    }
}

#[cfg(test)]
#[cfg(feature = "rand")]
mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::vec::Vec;

    use anyhow::Result;

    use crate::field::extension::FieldExtension;
    use crate::field::interpolation::interpolant;
    use crate::field::types::{Field, Sample};
    use crate::gates::coset_interpolation::CosetInterpolationGate;
    use crate::iop::witness::PartialWitness;
    use crate::plonk::circuit_builder::CircuitBuilder;
    use crate::plonk::circuit_data::CircuitConfig;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::plonk::verifier::verify;

    #[test]
    fn test_interpolate() -> Result<()> {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type FF = <C as GenericConfig<D>>::FE;
        let config = CircuitConfig::standard_recursion_config();
        let pw = PartialWitness::new();
        let mut builder = CircuitBuilder::<F, D>::new(config);

        let subgroup_bits = 2;
        let len = 1 << subgroup_bits;
        let coset_shift = F::rand();
        let g = F::primitive_root_of_unity(subgroup_bits);
        let points = F::cyclic_subgroup_coset_known_order(g, coset_shift, len);
        let values = FF::rand_vec(len);

        let homogeneous_points = points
            .iter()
            .zip(values.iter())
            .map(|(&a, &b)| (<FF as FieldExtension<D>>::from_basefield(a), b))
            .collect::<Vec<_>>();

        let true_interpolant = interpolant(&homogeneous_points);

        let z = FF::rand();
        let true_eval = true_interpolant.eval(z);

        let coset_shift_target = builder.constant(coset_shift);

        let value_targets = values
            .iter()
            .map(|&v| builder.constant_extension(v))
            .collect::<Vec<_>>();

        let zt = builder.constant_extension(z);

        let evals_coset_gates = (2..=4)
            .map(|max_degree| {
                builder.interpolate_coset(
                    CosetInterpolationGate::with_max_degree(subgroup_bits, max_degree),
                    coset_shift_target,
                    &value_targets,
                    zt,
                )
            })
            .collect::<Vec<_>>();
        let true_eval_target = builder.constant_extension(true_eval);
        for &eval_coset_gate in evals_coset_gates.iter() {
            builder.connect_extension(eval_coset_gate, true_eval_target);
        }

        let data = builder.build::<C>();
        let proof = data.prove(pw)?;

        verify(proof, &data.verifier_only, &data.common)
    }

    /// Test that coset interpolation proofs can be verified cross-crate.
    ///
    /// This catches prover/verifier gate drift (e.g., constraint count mismatches)
    /// by proving a circuit with CosetInterpolationGate using the prover crate,
    /// then deserializing and verifying using the standalone verifier crate.
    #[test]
    fn test_coset_interpolation_cross_crate_verification() -> Result<()> {
        use plonky2_verifier::plonk::circuit_data::{
            CommonCircuitData as VerifierCommonData, VerifierCircuitData,
            VerifierOnlyCircuitData as VerifierOnlyData,
        };
        use plonky2_verifier::plonk::proof::ProofWithPublicInputs as VerifierProof;
        use plonky2_verifier::util::serialization::DefaultGateSerializer as VerifierGateSerializer;

        use crate::plonk::prover::prove;
        use crate::util::serialization::DefaultGateSerializer as ProverGateSerializer;
        use crate::util::timing::TimingTree;

        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type FF = <C as GenericConfig<D>>::FE;

        let config = CircuitConfig::standard_recursion_config();
        let pw = PartialWitness::new();
        let mut builder = CircuitBuilder::<F, D>::new(config);

        // Build a circuit with CosetInterpolationGate
        let subgroup_bits = 2;
        let len = 1 << subgroup_bits;
        let coset_shift = F::rand();
        let g = F::primitive_root_of_unity(subgroup_bits);
        let points = F::cyclic_subgroup_coset_known_order(g, coset_shift, len);
        let values = FF::rand_vec(len);

        let homogeneous_points = points
            .iter()
            .zip(values.iter())
            .map(|(&a, &b)| (<FF as FieldExtension<D>>::from_basefield(a), b))
            .collect::<Vec<_>>();

        let true_interpolant = interpolant(&homogeneous_points);
        let z = FF::rand();
        let true_eval = true_interpolant.eval(z);

        let coset_shift_target = builder.constant(coset_shift);
        let value_targets = values
            .iter()
            .map(|&v| builder.constant_extension(v))
            .collect::<Vec<_>>();
        let zt = builder.constant_extension(z);

        // Add coset interpolation gate with max_degree=3
        let eval_coset = builder.interpolate_coset(
            CosetInterpolationGate::with_max_degree(subgroup_bits, 3),
            coset_shift_target,
            &value_targets,
            zt,
        );
        let true_eval_target = builder.constant_extension(true_eval);
        builder.connect_extension(eval_coset, true_eval_target);

        // Build and prove using prover crate
        let data = builder.build::<C>();
        let mut timing = TimingTree::new("prove coset interpolation", log::Level::Debug);
        let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

        // Verify directly first (using prover crate's verify)
        data.verify(proof.clone())?;

        // Serialize using prover's serializer
        let prover_gate_serializer = ProverGateSerializer;
        let common_bytes = data
            .common
            .to_bytes(&prover_gate_serializer)
            .expect("serialize common");
        let verifier_bytes = data.verifier_only.to_bytes().expect("serialize verifier");
        let proof_bytes = proof.to_bytes();

        // Deserialize using VERIFIER CRATE types (cross-crate verification path)
        let verifier_gate_serializer = VerifierGateSerializer;
        let common_deserialized =
            VerifierCommonData::<F, D>::from_bytes(common_bytes, &verifier_gate_serializer)
                .expect("deserialize common with verifier crate");

        let verifier_deserialized =
            VerifierOnlyData::<C, D>::from_bytes(verifier_bytes).expect("deserialize verifier");

        let proof_deserialized =
            VerifierProof::<F, C, D>::from_bytes(proof_bytes, &common_deserialized)
                .expect("deserialize proof with verifier crate");

        // Verify using verifier crate - this exercises the verifier's gate evaluation
        let verifier_data = VerifierCircuitData {
            verifier_only: verifier_deserialized,
            common: common_deserialized,
        };
        verifier_data.verify(proof_deserialized)?;

        Ok(())
    }

    /// Test that recursive proofs containing coset interpolation gates can be verified cross-crate.
    ///
    /// This is a more comprehensive test that:
    /// 1. Creates an inner circuit with CosetInterpolationGate
    /// 2. Creates an outer circuit that recursively verifies the inner proof
    /// 3. Proves the outer circuit (which uses coset interpolation in FRI verification)
    /// 4. Verifies the outer proof using the standalone verifier crate
    #[test]
    fn test_recursive_coset_interpolation_cross_crate_verification() -> Result<()> {
        use plonky2_verifier::plonk::circuit_data::{
            CommonCircuitData as VerifierCommonData, VerifierCircuitData,
            VerifierOnlyCircuitData as VerifierOnlyData,
        };
        use plonky2_verifier::plonk::proof::ProofWithPublicInputs as VerifierProof;
        use plonky2_verifier::util::serialization::DefaultGateSerializer as VerifierGateSerializer;

        use crate::iop::witness::WitnessWrite;
        use crate::plonk::prover::prove;
        use crate::util::serialization::DefaultGateSerializer as ProverGateSerializer;
        use crate::util::timing::TimingTree;

        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type FF = <C as GenericConfig<D>>::FE;

        let config = CircuitConfig::standard_recursion_config();

        // === Inner circuit with CosetInterpolationGate ===
        let mut inner_builder = CircuitBuilder::<F, D>::new(config.clone());
        let inner_pw = PartialWitness::new();

        let subgroup_bits = 2;
        let len = 1 << subgroup_bits;
        let coset_shift = F::rand();
        let g = F::primitive_root_of_unity(subgroup_bits);
        let points = F::cyclic_subgroup_coset_known_order(g, coset_shift, len);
        let values = FF::rand_vec(len);

        let homogeneous_points = points
            .iter()
            .zip(values.iter())
            .map(|(&a, &b)| (<FF as FieldExtension<D>>::from_basefield(a), b))
            .collect::<Vec<_>>();

        let true_interpolant = interpolant(&homogeneous_points);
        let z = FF::rand();
        let true_eval = true_interpolant.eval(z);

        let coset_shift_target = inner_builder.constant(coset_shift);
        let value_targets = values
            .iter()
            .map(|&v| inner_builder.constant_extension(v))
            .collect::<Vec<_>>();
        let zt = inner_builder.constant_extension(z);

        let eval_coset = inner_builder.interpolate_coset(
            CosetInterpolationGate::with_max_degree(subgroup_bits, 3),
            coset_shift_target,
            &value_targets,
            zt,
        );
        let true_eval_target = inner_builder.constant_extension(true_eval);
        inner_builder.connect_extension(eval_coset, true_eval_target);

        let inner_data = inner_builder.build::<C>();
        let mut timing = TimingTree::new("prove inner", log::Level::Debug);
        let inner_proof = prove(
            &inner_data.prover_only,
            &inner_data.common,
            inner_pw,
            &mut timing,
        )?;
        inner_data.verify(inner_proof.clone())?;

        // === Outer circuit that recursively verifies the inner proof ===
        let mut outer_builder = CircuitBuilder::<F, D>::new(config.clone());
        let mut outer_pw = PartialWitness::new();

        let pt = outer_builder.add_virtual_proof_with_pis(&inner_data.common);
        outer_pw.set_proof_with_pis_target(&pt, &inner_proof)?;

        let inner_verifier_data =
            outer_builder.add_virtual_verifier_data(inner_data.common.config.fri_config.cap_height);
        outer_pw.set_cap_target(
            &inner_verifier_data.constants_sigmas_cap,
            &inner_data.verifier_only.constants_sigmas_cap,
        )?;
        outer_pw.set_hash_target(
            inner_verifier_data.circuit_digest,
            inner_data.verifier_only.circuit_digest,
        )?;

        outer_builder.verify_proof::<C>(&pt, &inner_verifier_data, &inner_data.common);

        let outer_data = outer_builder.build::<C>();
        let mut timing = TimingTree::new("prove outer recursive", log::Level::Debug);
        let outer_proof = prove(
            &outer_data.prover_only,
            &outer_data.common,
            outer_pw,
            &mut timing,
        )?;

        // Verify directly first
        outer_data.verify(outer_proof.clone())?;

        // Serialize using prover's serializer
        let prover_gate_serializer = ProverGateSerializer;
        let common_bytes = outer_data
            .common
            .to_bytes(&prover_gate_serializer)
            .expect("serialize common");
        let verifier_bytes = outer_data
            .verifier_only
            .to_bytes()
            .expect("serialize verifier");
        let proof_bytes = outer_proof.to_bytes();

        // Deserialize using VERIFIER CRATE types
        let verifier_gate_serializer = VerifierGateSerializer;
        let common_deserialized =
            VerifierCommonData::<F, D>::from_bytes(common_bytes, &verifier_gate_serializer)
                .expect("deserialize common with verifier crate");

        let verifier_deserialized =
            VerifierOnlyData::<C, D>::from_bytes(verifier_bytes).expect("deserialize verifier");

        let proof_deserialized =
            VerifierProof::<F, C, D>::from_bytes(proof_bytes, &common_deserialized)
                .expect("deserialize proof with verifier crate");

        // Verify recursive proof using verifier crate
        let verifier_data = VerifierCircuitData {
            verifier_only: verifier_deserialized,
            common: common_deserialized,
        };
        verifier_data.verify(proof_deserialized)?;

        Ok(())
    }
}
