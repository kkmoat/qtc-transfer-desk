#[macro_use]
extern crate criterion;

use criterion::{Criterion, Fun};
use rand::distributions::{Distribution, Standard};
use rand::prelude::*;
use unroll::unroll_for_loops;

static SEED: [u8; 32] = [3; 32];
const N: usize = 5;

#[inline]
fn make_random_prod_pair() -> ([[f64; N]; N], [f64; N])
where
    Standard: Distribution<f64>,
{
    let mut rng: StdRng = SeedableRng::from_seed(SEED);
    let mut mtx = [[0.0; N]; N];
    let mut vec = [0.0; N];
    for i in 0..N {
        for j in 0..N {
            mtx[i][j] = rng.gen();
        }
        vec[i] = rng.gen();
    }

    (mtx, vec)
}

#[inline]
fn mtx_vec_mul(mtx: &[[f64; N]; N], vec: &[f64; N]) -> [f64; N] {
    let mut out = [0.0; N];
    for col in 0..5 {
        for row in 0..5 {
            out[row] += mtx[col][row] * vec[col];
        }
    }
    out
}

#[inline]
#[unroll_for_loops]
fn unroll_mtx_vec_mul(mtx: &[[f64; N]; N], vec: &[f64; N]) -> [f64; N] {
    let mut out = [0.0; N];
    for col in 0..5 {
        for row in 0..5 {
            out[row] += mtx[col][row] * vec[col];
        }
    }
    out
}

fn matrix_vector_product(c: &mut Criterion) {
    let mtx_vec_mul = Fun::new("Ordinary", move |b, _| {
        let (m, v) = make_random_prod_pair();
        b.iter(|| mtx_vec_mul(&m, &v))
    });

    let unrolled_mtx_vec_mul = Fun::new("Unrolled", move |b, _| {
        let (m, v) = make_random_prod_pair();
        b.iter(|| unroll_mtx_vec_mul(&m, &v))
    });

    let fns = vec![
        mtx_vec_mul,
        unrolled_mtx_vec_mul,
    ];
    c.bench_functions("Matrix-Vector Product", fns, ());
}

criterion_group!(benches, matrix_vector_product);
criterion_main!(benches);
