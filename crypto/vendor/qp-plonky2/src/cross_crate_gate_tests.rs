//! Cross-crate gate verification tests.
//!
//! These tests verify that circuits using specific gates can be proven by the prover crate
//! and verified by the standalone verifier crate. This catches drift between the two crates'
//! gate implementations (e.g., constraint count mismatches, different evaluation logic).
//!
//! Each test:
//! 1. Creates a circuit that exercises a specific gate
//! 2. Proves it using the prover crate
//! 3. Serializes the proof, common data, and verifier data
//! 4. Deserializes using the verifier crate's types
//! 5. Verifies using the verifier crate
//!
//! If the gate implementations drift, verification will fail.

use anyhow::Result;
use plonky2_verifier::plonk::circuit_data::{
    CommonCircuitData as VerifierCommonData, VerifierCircuitData,
    VerifierOnlyCircuitData as VerifierOnlyData,
};
use plonky2_verifier::plonk::proof::ProofWithPublicInputs as VerifierProof;
use plonky2_verifier::util::serialization::DefaultGateSerializer as VerifierGateSerializer;

use crate::field::extension::Extendable;
use crate::field::types::Field;
use crate::hash::hash_types::RichField;
use crate::iop::witness::{PartialWitness, WitnessWrite};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::circuit_data::CircuitConfig;
use crate::plonk::config::{AlgebraicHasher, GenericConfig, PoseidonGoldilocksConfig};
use crate::plonk::prover::prove;
use crate::util::serialization::DefaultGateSerializer as ProverGateSerializer;
use crate::util::timing::TimingTree;

const D: usize = 2;
type C = PoseidonGoldilocksConfig;
type F = <C as GenericConfig<D>>::F;

/// Helper function to verify a proof using the verifier crate.
fn verify_with_verifier_crate<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
>(
    common: &crate::plonk::circuit_data::CommonCircuitData<F, D>,
    verifier_only: &crate::plonk::circuit_data::VerifierOnlyCircuitData<C, D>,
    proof: &crate::plonk::proof::ProofWithPublicInputs<F, C, D>,
) where
    C::Hasher: AlgebraicHasher<F>,
{
    let prover_gate_serializer = ProverGateSerializer;
    let verifier_gate_serializer = VerifierGateSerializer;

    // Serialize using prover crate
    let common_bytes = common
        .to_bytes(&prover_gate_serializer)
        .expect("serialize common");
    let verifier_bytes = verifier_only.to_bytes().expect("serialize verifier");
    let proof_bytes = proof.to_bytes();

    // Deserialize using verifier crate
    let common_deserialized =
        VerifierCommonData::<F, D>::from_bytes(common_bytes, &verifier_gate_serializer)
            .expect("deserialize common");
    let verifier_deserialized =
        VerifierOnlyData::<C, D>::from_bytes(verifier_bytes).expect("deserialize verifier");
    let proof_deserialized =
        VerifierProof::<F, C, D>::from_bytes(proof_bytes, &common_deserialized)
            .expect("deserialize proof");

    // Verify using verifier crate
    let verifier_data = VerifierCircuitData {
        verifier_only: verifier_deserialized,
        common: common_deserialized,
    };
    verifier_data
        .verify(proof_deserialized)
        .expect("verifier crate verification");
}

/// Test RandomAccessGate cross-crate verification.
///
/// RandomAccessGate is used in FRI recursive verification for selecting evaluations.
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_random_access_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create an array of values and select from it
    let values: Vec<_> = (0..8)
        .map(|i| builder.constant(F::from_canonical_usize(i * 10)))
        .collect();
    let index = builder.add_virtual_target();

    // Use random_access to select a value - this uses RandomAccessGate
    let selected = builder.random_access(index, values.clone());

    builder.register_public_input(index);
    builder.register_public_input(selected);

    // Verify the gate was actually used
    let data = builder.build::<C>();
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("RandomAccessGate"));
    assert!(gate_used, "RandomAccessGate should be used in this circuit");

    // Prove with index = 3, expected value = 30
    let mut pw = PartialWitness::new();
    pw.set_target(index, F::from_canonical_usize(3))?;

    let mut timing = TimingTree::new("prove random_access", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate first
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test PoseidonGate cross-crate verification.
///
/// PoseidonGate is used for all Poseidon hashing in Merkle proofs.
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_poseidon_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create inputs for hashing
    let inputs: Vec<_> = (0..8).map(|_| builder.add_virtual_target()).collect();

    // Hash using Poseidon - this uses PoseidonGate
    let hash = builder.hash_n_to_hash_no_pad::<crate::hash::poseidon::PoseidonHash>(inputs.clone());

    // Register inputs and outputs as public
    for input in &inputs {
        builder.register_public_input(*input);
    }
    for elem in hash.elements {
        builder.register_public_input(elem);
    }

    let data = builder.build::<C>();

    // Verify PoseidonGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("PoseidonGate"));
    assert!(gate_used, "PoseidonGate should be used in this circuit");

    // Prove
    let mut pw = PartialWitness::new();
    for (i, input) in inputs.iter().enumerate() {
        pw.set_target(*input, F::from_canonical_usize(i + 1))?;
    }

    let mut timing = TimingTree::new("prove poseidon", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test Poseidon2Gate cross-crate verification.
///
/// Poseidon2Gate is an alternative hash function with different performance characteristics.
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_poseidon2_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create inputs for hashing
    let inputs: Vec<_> = (0..8).map(|_| builder.add_virtual_target()).collect();

    // Hash using Poseidon2 - this uses Poseidon2Gate
    let hash =
        builder.hash_n_to_hash_no_pad::<crate::hash::poseidon2::Poseidon2Hash>(inputs.clone());

    // Register inputs and outputs as public
    for input in &inputs {
        builder.register_public_input(*input);
    }
    for elem in hash.elements {
        builder.register_public_input(elem);
    }

    let data = builder.build::<C>();

    // Verify Poseidon2Gate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("Poseidon2Gate"));
    assert!(gate_used, "Poseidon2Gate should be used in this circuit");

    // Prove
    let mut pw = PartialWitness::new();
    for (i, input) in inputs.iter().enumerate() {
        pw.set_target(*input, F::from_canonical_usize(i + 1))?;
    }

    let mut timing = TimingTree::new("prove poseidon2", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate (using same C since hash is internal)
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test ArithmeticGate cross-crate verification.
///
/// ArithmeticGate is used for basic field arithmetic (add, mul, etc.).
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_arithmetic_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    let a = builder.add_virtual_target();
    let b = builder.add_virtual_target();

    // Perform arithmetic operations - these use ArithmeticGate
    let sum = builder.add(a, b);
    let product = builder.mul(a, b);
    let combined = builder.mul_add(a, b, sum); // a*b + (a+b)

    builder.register_public_input(a);
    builder.register_public_input(b);
    builder.register_public_input(sum);
    builder.register_public_input(product);
    builder.register_public_input(combined);

    let data = builder.build::<C>();

    // Verify ArithmeticGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("ArithmeticGate"));
    assert!(gate_used, "ArithmeticGate should be used in this circuit");

    // Prove with a=5, b=7
    let mut pw = PartialWitness::new();
    pw.set_target(a, F::from_canonical_usize(5))?;
    pw.set_target(b, F::from_canonical_usize(7))?;

    let mut timing = TimingTree::new("prove arithmetic", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Check public inputs: a=5, b=7, sum=12, product=35, combined=47
    assert_eq!(proof.public_inputs[0], F::from_canonical_usize(5));
    assert_eq!(proof.public_inputs[1], F::from_canonical_usize(7));
    assert_eq!(proof.public_inputs[2], F::from_canonical_usize(12));
    assert_eq!(proof.public_inputs[3], F::from_canonical_usize(35));
    assert_eq!(proof.public_inputs[4], F::from_canonical_usize(47));

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test ReducingGate cross-crate verification.
///
/// ReducingGate is used for polynomial evaluation (Horner's method).
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_reducing_gate_cross_crate() -> Result<()> {
    use crate::util::reducing::ReducingFactorTarget;

    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create many coefficients to ensure ReducingGate is used (not just ArithmeticGate)
    // ReducingGate is only used when there are many terms
    let num_coeffs = 32; // More than ArithmeticExtensionGate can handle
    let coeffs: Vec<_> = (0..num_coeffs)
        .map(|_| builder.add_virtual_target())
        .collect();
    let alpha = builder.add_virtual_extension_target();

    // Use ReducingFactorTarget to evaluate polynomial - this uses ReducingGate for many terms
    let mut reducing = ReducingFactorTarget::<D>::new(alpha);
    let result = reducing.reduce_base(&coeffs, &mut builder);

    // Register outputs
    for coeff in &coeffs {
        builder.register_public_input(*coeff);
    }
    for elem in result.to_target_array() {
        builder.register_public_input(elem);
    }

    let data = builder.build::<C>();

    // Verify ReducingGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("ReducingGate"));
    assert!(gate_used, "ReducingGate should be used in this circuit");

    // Prove
    let mut pw = PartialWitness::new();
    for (i, coeff) in coeffs.iter().enumerate() {
        pw.set_target(*coeff, F::from_canonical_usize(i + 1))?;
    }
    // Set alpha to a simple extension value [2, 0]
    use crate::field::extension::quadratic::QuadraticExtension;
    use crate::field::extension::FieldExtension;
    type FE = QuadraticExtension<F>;
    pw.set_extension_target(alpha, FE::from_basefield_array([F::TWO, F::ZERO]))?;

    let mut timing = TimingTree::new("prove reducing", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test ExponentiationGate cross-crate verification.
///
/// ExponentiationGate is used for computing x^n efficiently.
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_exponentiation_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    let base = builder.add_virtual_target();

    // Compute base^10 using exp_u64 - this uses ExponentiationGate
    let result = builder.exp_u64(base, 10);

    builder.register_public_input(base);
    builder.register_public_input(result);

    let data = builder.build::<C>();

    // Verify ExponentiationGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("ExponentiationGate"));
    assert!(
        gate_used,
        "ExponentiationGate should be used in this circuit"
    );

    // Prove with base=3, result should be 3^10 = 59049
    let mut pw = PartialWitness::new();
    pw.set_target(base, F::from_canonical_usize(3))?;

    let mut timing = TimingTree::new("prove exponentiation", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify result: 3^10 = 59049
    assert_eq!(proof.public_inputs[0], F::from_canonical_usize(3));
    assert_eq!(proof.public_inputs[1], F::from_canonical_usize(59049));

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test BaseSumGate cross-crate verification.
///
/// BaseSumGate is used for base decomposition (e.g., binary, base-4).
/// This test ensures the prover and verifier agree on the gate's constraints.
#[test]
fn test_base_sum_gate_cross_crate() -> Result<()> {
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    let value = builder.add_virtual_target();

    // Split into binary (base 2) representation - this uses BaseSumGate
    let bits = builder.split_le(value, 8);

    builder.register_public_input(value);
    for bit in &bits {
        builder.register_public_input(bit.target);
    }

    let data = builder.build::<C>();

    // Verify BaseSumGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("BaseSumGate"));
    assert!(gate_used, "BaseSumGate should be used in this circuit");

    // Prove with value=170 (binary: 10101010)
    let mut pw = PartialWitness::new();
    pw.set_target(value, F::from_canonical_usize(170))?;

    let mut timing = TimingTree::new("prove base_sum", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify bits: 170 = 0b10101010 (LSB first: 0,1,0,1,0,1,0,1)
    assert_eq!(proof.public_inputs[0], F::from_canonical_usize(170));
    assert_eq!(proof.public_inputs[1], F::ZERO); // bit 0
    assert_eq!(proof.public_inputs[2], F::ONE); // bit 1
    assert_eq!(proof.public_inputs[3], F::ZERO); // bit 2
    assert_eq!(proof.public_inputs[4], F::ONE); // bit 3
    assert_eq!(proof.public_inputs[5], F::ZERO); // bit 4
    assert_eq!(proof.public_inputs[6], F::ONE); // bit 5
    assert_eq!(proof.public_inputs[7], F::ZERO); // bit 6
    assert_eq!(proof.public_inputs[8], F::ONE); // bit 7

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test combined gates in a recursive circuit.
///
/// This tests the interaction of multiple gates in a recursive proof verification.
/// It's particularly important because recursive verification uses many gates internally.
#[test]
fn test_recursive_proof_cross_crate() -> Result<()> {
    // Build a simple inner circuit
    let inner_config = CircuitConfig::standard_recursion_config();
    let mut inner_builder = CircuitBuilder::<F, D>::new(inner_config);

    let a = inner_builder.add_virtual_target();
    let b = inner_builder.add_virtual_target();
    let sum = inner_builder.add(a, b);
    inner_builder.register_public_input(a);
    inner_builder.register_public_input(b);
    inner_builder.register_public_input(sum);

    let inner_data = inner_builder.build::<C>();

    // Prove the inner circuit
    let mut inner_pw = PartialWitness::new();
    inner_pw.set_target(a, F::from_canonical_usize(5))?;
    inner_pw.set_target(b, F::from_canonical_usize(7))?;

    let mut timing = TimingTree::new("prove inner", log::Level::Debug);
    let inner_proof = prove(
        &inner_data.prover_only,
        &inner_data.common,
        inner_pw,
        &mut timing,
    )?;
    inner_data.verify(inner_proof.clone())?;

    // Build an outer circuit that verifies the inner proof
    let outer_config = CircuitConfig::standard_recursion_config();
    let mut outer_builder = CircuitBuilder::<F, D>::new(outer_config);

    let proof_target = outer_builder.add_virtual_proof_with_pis(&inner_data.common);
    let verifier_data_target =
        outer_builder.add_virtual_verifier_data(inner_data.common.config.fri_config.cap_height);

    outer_builder.verify_proof::<C>(&proof_target, &verifier_data_target, &inner_data.common);

    // Forward the public inputs
    for pi in &proof_target.public_inputs {
        outer_builder.register_public_input(*pi);
    }

    let outer_data = outer_builder.build::<C>();

    // Set the witness for outer circuit
    let mut outer_pw = PartialWitness::new();
    outer_pw.set_proof_with_pis_target(&proof_target, &inner_proof)?;
    outer_pw.set_verifier_data_target(&verifier_data_target, &inner_data.verifier_only)?;

    let mut timing = TimingTree::new("prove outer", log::Level::Debug);
    let outer_proof = prove(
        &outer_data.prover_only,
        &outer_data.common,
        outer_pw,
        &mut timing,
    )?;

    // Verify outer proof with prover crate
    outer_data.verify(outer_proof.clone())?;

    // Verify outer proof with verifier crate
    verify_with_verifier_crate(&outer_data.common, &outer_data.verifier_only, &outer_proof);

    Ok(())
}

/// Test PoseidonMdsGate cross-crate verification.
///
/// PoseidonMdsGate computes the MDS (Maximum Distance Separable) matrix multiplication
/// used in the Poseidon permutation. While not used directly in circuits (MDS is computed
/// inline), we test it to ensure the gate implementations match between prover and verifier.
#[test]
fn test_poseidon_mds_gate_cross_crate() -> Result<()> {
    use crate::gates::poseidon_mds::PoseidonMdsGate;
    use crate::hash::poseidon::SPONGE_WIDTH;
    use crate::iop::ext_target::ExtensionTarget;
    use crate::iop::target::Target;

    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create input targets for the MDS gate (SPONGE_WIDTH extension elements)
    let inputs: Vec<_> = (0..SPONGE_WIDTH)
        .map(|_| builder.add_virtual_extension_target())
        .collect();

    // Add the PoseidonMdsGate directly
    let gate = PoseidonMdsGate::<F, D>::new();
    let row = builder.add_gate(gate, vec![]);

    // Connect inputs to the gate's input wires
    for (i, input) in inputs.iter().enumerate() {
        let wire_range = PoseidonMdsGate::<F, D>::wires_input(i);
        for (j, wire_idx) in wire_range.enumerate() {
            builder.connect(input.to_target_array()[j], Target::wire(row, wire_idx));
        }
    }

    // Get output targets from the gate
    let outputs: Vec<ExtensionTarget<D>> = (0..SPONGE_WIDTH)
        .map(|i| {
            let wire_range = PoseidonMdsGate::<F, D>::wires_output(i);
            ExtensionTarget::from_range(row, wire_range)
        })
        .collect();

    // Register inputs and outputs as public
    for input in &inputs {
        for elem in input.to_target_array() {
            builder.register_public_input(elem);
        }
    }
    for output in &outputs {
        for elem in output.to_target_array() {
            builder.register_public_input(elem);
        }
    }

    let data = builder.build::<C>();

    // Verify PoseidonMdsGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("PoseidonMdsGate"));
    assert!(gate_used, "PoseidonMdsGate should be used in this circuit");

    // Prove with some input values
    let mut pw = PartialWitness::new();
    use crate::field::extension::quadratic::QuadraticExtension;
    use crate::field::extension::FieldExtension;
    type FE = QuadraticExtension<F>;
    for (i, input) in inputs.iter().enumerate() {
        let val = FE::from_basefield_array([
            F::from_canonical_usize(i + 1),
            F::from_canonical_usize(i + 100),
        ]);
        pw.set_extension_target(*input, val)?;
    }

    let mut timing = TimingTree::new("prove poseidon_mds", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test Poseidon2MdsGate cross-crate verification.
///
/// Poseidon2MdsGate computes the light MDS matrix multiplication used in Poseidon2.
/// While not used directly in circuits (MDS is computed inline), we test it to ensure
/// the gate implementations match between prover and verifier.
#[test]
fn test_poseidon2_mds_gate_cross_crate() -> Result<()> {
    use crate::gates::poseidon2::SPONGE_WIDTH;
    use crate::gates::poseidon2_mds::Poseidon2MdsGate;
    use crate::iop::ext_target::ExtensionTarget;
    use crate::iop::target::Target;

    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create input targets for the MDS gate (SPONGE_WIDTH extension elements)
    let inputs: Vec<_> = (0..SPONGE_WIDTH)
        .map(|_| builder.add_virtual_extension_target())
        .collect();

    // Add the Poseidon2MdsGate directly
    let gate = Poseidon2MdsGate::<F, D>::new();
    let row = builder.add_gate(gate, vec![]);

    // Connect inputs to the gate's input wires
    for (i, input) in inputs.iter().enumerate() {
        let wire_range = Poseidon2MdsGate::<F, D>::wires_input(i);
        for (j, wire_idx) in wire_range.enumerate() {
            builder.connect(input.to_target_array()[j], Target::wire(row, wire_idx));
        }
    }

    // Get output targets from the gate
    let outputs: Vec<ExtensionTarget<D>> = (0..SPONGE_WIDTH)
        .map(|i| {
            let wire_range = Poseidon2MdsGate::<F, D>::wires_output(i);
            ExtensionTarget::from_range(row, wire_range)
        })
        .collect();

    // Register inputs and outputs as public
    for input in &inputs {
        for elem in input.to_target_array() {
            builder.register_public_input(elem);
        }
    }
    for output in &outputs {
        for elem in output.to_target_array() {
            builder.register_public_input(elem);
        }
    }

    let data = builder.build::<C>();

    // Verify Poseidon2MdsGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("Poseidon2MdsGate"));
    assert!(gate_used, "Poseidon2MdsGate should be used in this circuit");

    // Prove with some input values
    let mut pw = PartialWitness::new();
    use crate::field::extension::quadratic::QuadraticExtension;
    use crate::field::extension::FieldExtension;
    type FE = QuadraticExtension<F>;
    for (i, input) in inputs.iter().enumerate() {
        let val = FE::from_basefield_array([
            F::from_canonical_usize(i + 1),
            F::from_canonical_usize(i + 100),
        ]);
        pw.set_extension_target(*input, val)?;
    }

    let mut timing = TimingTree::new("prove poseidon2_mds", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}

/// Test Poseidon2IntMixGate cross-crate verification.
///
/// Poseidon2IntMixGate computes the internal mixing step in Poseidon2 partial rounds.
/// While not used directly in circuits (mixing is computed inline), we test it to ensure
/// the gate implementations match between prover and verifier.
#[test]
fn test_poseidon2_int_mix_gate_cross_crate() -> Result<()> {
    use crate::gates::poseidon2::SPONGE_WIDTH;
    use crate::gates::poseidon2_int_mix::Poseidon2IntMixGate;
    use crate::iop::ext_target::ExtensionTarget;
    use crate::iop::target::Target;

    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Create input targets for the gate (SPONGE_WIDTH extension elements)
    let inputs: Vec<_> = (0..SPONGE_WIDTH)
        .map(|_| builder.add_virtual_extension_target())
        .collect();

    // Add the Poseidon2IntMixGate directly
    let gate = Poseidon2IntMixGate::<F, D>::new();
    let row = builder.add_gate(gate, vec![]);

    // Connect inputs to the gate's input wires
    for (i, input) in inputs.iter().enumerate() {
        let wire_range = Poseidon2IntMixGate::<F, D>::wires_input(i);
        for (j, wire_idx) in wire_range.enumerate() {
            builder.connect(input.to_target_array()[j], Target::wire(row, wire_idx));
        }
    }

    // Get output targets from the gate
    let outputs: Vec<ExtensionTarget<D>> = (0..SPONGE_WIDTH)
        .map(|i| {
            let wire_range = Poseidon2IntMixGate::<F, D>::wires_output(i);
            ExtensionTarget::from_range(row, wire_range)
        })
        .collect();

    // Register inputs and outputs as public
    for input in &inputs {
        for elem in input.to_target_array() {
            builder.register_public_input(elem);
        }
    }
    for output in &outputs {
        for elem in output.to_target_array() {
            builder.register_public_input(elem);
        }
    }

    let data = builder.build::<C>();

    // Verify Poseidon2IntMixGate was used
    let gate_used = data
        .common
        .gates
        .iter()
        .any(|g| g.0.id().contains("Poseidon2IntMixGate"));
    assert!(
        gate_used,
        "Poseidon2IntMixGate should be used in this circuit"
    );

    // Prove with some input values
    let mut pw = PartialWitness::new();
    use crate::field::extension::quadratic::QuadraticExtension;
    use crate::field::extension::FieldExtension;
    type FE = QuadraticExtension<F>;
    for (i, input) in inputs.iter().enumerate() {
        let val = FE::from_basefield_array([
            F::from_canonical_usize(i + 1),
            F::from_canonical_usize(i + 100),
        ]);
        pw.set_extension_target(*input, val)?;
    }

    let mut timing = TimingTree::new("prove poseidon2_int_mix", log::Level::Debug);
    let proof = prove(&data.prover_only, &data.common, pw, &mut timing)?;

    // Verify with prover crate
    data.verify(proof.clone())?;

    // Verify with verifier crate
    verify_with_verifier_crate(&data.common, &data.verifier_only, &proof);

    Ok(())
}
