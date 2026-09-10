mod allocator;

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use plonky2::field::types::Field;
use plonky2::hash::hashing::PlonkyPermutation;
use plonky2::hash::poseidon::{PoseidonHash, SPONGE_WIDTH};
use plonky2::hash::poseidon2::Poseidon2Hash;
use plonky2::iop::target::{BoolTarget, Target};
use plonky2::iop::witness::{PartialWitness, WitnessWrite};
use plonky2::plonk::circuit_builder::CircuitBuilder;
use plonky2::plonk::circuit_data::CircuitConfig;
use plonky2::plonk::config::{AlgebraicHasher, GenericConfig, PoseidonGoldilocksConfig};
use rand::rngs::StdRng;
use rand::{RngExt, SeedableRng};
const D: usize = 2;
// Use Poseidon1 config for the proof system (FRI/Merkle trees)
// The benchmark compares Poseidon1 vs Poseidon2 *circuit gates*, not the proof system config
type C = PoseidonGoldilocksConfig;
type F = <C as GenericConfig<D>>::F;

const NUM_PERMS: usize = 100; // Number of permutations to perform in the circuit

// Helper: Generate fixed random inputs for fairness
fn generate_inputs(rng: &mut StdRng) -> Vec<[F; SPONGE_WIDTH]> {
    (0..NUM_PERMS)
        .map(|_| {
            let mut state = [F::ZERO; SPONGE_WIDTH];
            for i in 0..SPONGE_WIDTH {
                state[i] = F::from_canonical_u64(rng.random());
            }
            state
        })
        .collect()
}

fn bench_poseidon_air(c: &mut Criterion) {
    let mut rng = StdRng::seed_from_u64(0xdeadbeef);
    let inputs = generate_inputs(&mut rng);

    // 1) Build circuit ONCE
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Add inputs as targets
    let input_targets: Vec<[Target; SPONGE_WIDTH]> = (0..NUM_PERMS)
        .map(|_| [(); SPONGE_WIDTH].map(|_| builder.add_virtual_target()))
        .collect();

    // Perform permutations using Poseidon1 gates
    for input_t in input_targets.iter() {
        let perm = <PoseidonHash as AlgebraicHasher<F>>::AlgebraicPermutation::new(
            input_t.iter().cloned(),
        );
        let swap = builder.zero(); // No swap
        let out = PoseidonHash::permute_swapped(perm, BoolTarget::new_unsafe(swap), &mut builder);
        // Register output to ensure it's computed (dummy)
        builder.register_public_inputs(&out.squeeze());
    }

    // Build with Poseidon1 config
    let data = builder.build::<C>();

    // 2) Build witness ONCE
    let mut base_pw = PartialWitness::new();
    for (i, state) in inputs.iter().enumerate() {
        for (j, &val) in state.iter().enumerate() {
            base_pw.set_target(input_targets[i][j], val).unwrap();
        }
    }

    // 3) Pure prover benchmark: only data.prove(...)
    c.bench_function("poseidon1_prove", |b| {
        b.iter(|| {
            let pw = base_pw.clone();
            let proof = data.prove(pw).unwrap();
            black_box(proof);
        })
    });
}

fn bench_poseidon2_air(c: &mut Criterion) {
    let mut rng = StdRng::seed_from_u64(0xdeadbeef);
    let inputs = generate_inputs(&mut rng);

    // 1) Build circuit ONCE
    let config = CircuitConfig::standard_recursion_config();
    let mut builder = CircuitBuilder::<F, D>::new(config);

    // Add inputs as targets
    let input_targets: Vec<[Target; SPONGE_WIDTH]> = (0..NUM_PERMS)
        .map(|_| [(); SPONGE_WIDTH].map(|_| builder.add_virtual_target()))
        .collect();

    // Perform permutations using Poseidon2 gates
    for input_t in input_targets.iter() {
        let perm = <Poseidon2Hash as AlgebraicHasher<F>>::AlgebraicPermutation::new(
            input_t.iter().cloned(),
        );
        let swap = builder.zero(); // No swap
        let out = Poseidon2Hash::permute_swapped(perm, BoolTarget::new_unsafe(swap), &mut builder);
        // Register output to ensure it's computed (dummy)
        builder.register_public_inputs(&out.squeeze());
    }

    // Build with Poseidon1 config (proof system uses Poseidon1, but circuit gates use Poseidon2)
    let data = builder.build::<C>();

    // 2) Build witness ONCE
    let mut base_pw = PartialWitness::new();
    for (i, state) in inputs.iter().enumerate() {
        for (j, &val) in state.iter().enumerate() {
            base_pw.set_target(input_targets[i][j], val).unwrap();
        }
    }

    // 3) Pure prover benchmark
    c.bench_function("poseidon2_prove", |b| {
        b.iter(|| {
            let pw = base_pw.clone();
            let proof = data.prove(pw).unwrap();
            black_box(proof);
        })
    });
}

fn criterion_benchmark(c: &mut Criterion) {
    bench_poseidon2_air(c);
    bench_poseidon_air(c);
}

criterion_group!(benches, criterion_benchmark);
criterion_main!(benches);
