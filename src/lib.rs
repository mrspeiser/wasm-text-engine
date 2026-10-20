use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn uppercase(string: &str) -> String {
    string.to_uppercase()
}

#[wasm_bindgen]
pub fn count_rows(input: &str) -> usize {
    input.lines().count()
}