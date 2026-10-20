fn main() {
    let name = "Rust";
    let mut counter = 0;

    println!("Learning {}!", name);

    for i in 1..=5 {
        counter += i;
        println!("i: {}, counter: {}", i, counter);
    }

    let name = String::from("Matthew");

    greet(name);

}

fn greet(person: String) {
    println!("Welcome, {}!", person);
}