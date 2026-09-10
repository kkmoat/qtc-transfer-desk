#[macro_use]
extern crate criterion;

use criterion::{Criterion, Fun};
use rand::distributions::{Distribution, Standard};
use rand::prelude::*;
use unroll::unroll_for_loops;

static SEED: [u8; 32] = [3; 32];
const LEN: usize = 524_288;

#[inline]
fn make_random_vec(len: usize) -> Vec<f64>
where
    Standard: Distribution<f64>,
{
    let mut rng: StdRng = SeedableRng::from_seed(SEED);
    (0..len).map(|_| rng.gen()).collect()
}

#[inline]
#[unroll_for_loops]
fn unrolled_inner_sum(v: &[f64]) -> f64 {
    let mut res = [0.0; 32];
    for i in (0..v.len()).step_by(32) {
        for j in 0..32 {
            res[j] += v[i + j];
        }
    }
    res.iter().sum()
}

#[inline]
fn unrolled_sum(v: &[f64]) -> f64 {
    let mut res = [0.0; 32];
    for i in (0..v.len()).step_by(32) {
        for j in 0..32 {
            res[j] += v[i + j];
        }
    }
    res.iter().sum()
}

#[inline]
fn explicit_sum(v: &[f64]) -> f64 {
    let mut res = 0.0;
    for i in 0..v.len() {
        res += v[i];
    }
    res
}

fn test_sum_implementations() {
    let v = make_random_vec(LEN);
    let sum = v.iter().sum::<f64>();
    assert!((sum - explicit_sum(&v)).abs() < 1e-5);
    assert!((sum - unrolled_sum(&v)).abs() < 1e-5);
    assert!((sum - unrolled_inner_sum(&v)).abs() < 1e-5);
}

fn unroll_sum(c: &mut Criterion) {
    test_sum_implementations();

    let iter_sum = Fun::new("Iter Sum", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| v.iter().sum::<f64>())
    });

    let explicit_sum = Fun::new("Explicit Sum", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| explicit_sum(&v))
    });

    let unrolled_sum = Fun::new("Unrolled Sum", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| unrolled_sum(&v))
    });

    let unrolled_inner_sum = Fun::new("Unrolled Inner Sum", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| unrolled_inner_sum(&v))
    });

    let fns = vec![
        iter_sum,
        explicit_sum,
        unrolled_sum,
        unrolled_inner_sum,
    ];
    c.bench_functions("Unroll Sum", fns, ());
}

criterion_group!(benches, unroll_sum);
criterion_main!(benches);
