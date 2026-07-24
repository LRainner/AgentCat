#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if agent_cat_lib::handle_cli() {
        return;
    }
    agent_cat_lib::run();
}
