//! Every declared CLI behind one type, for the callers that only have a key
//! (the wire, the JSON export). Generated from the list `build.rs` makes of
//! `src/vendors/`: each arm is that vendor's own compiled observer, so
//! looking one up by key is the only dispatch there is.
use crate::decl::{self, Cli, Form, Vendor};
use crate::observe::{ActivityEvent, Error, Note, Observer, TurnUsage, UsageRead};
use serde_json::{Map, Value};
use std::path::Path;

/// Something done for every declared CLI, generically (`each`).
pub trait Visit {
    fn vendor<V: Vendor>(&mut self, file: &'static str);
}

macro_rules! registry {
    ($($vendor:ident),* $(,)?) => {
        /// Every declared CLI, sorted by key.
        pub static ALL: &[&Cli] = &[$(<crate::vendors::$vendor::V as Vendor>::CLI),*];

        /// Every declaration as JSON, in the same order.
        pub fn export() -> Vec<Value> {
            vec![$(decl::export::<crate::vendors::$vendor::V>()),*]
        }

        /// The launch and resume part of every declaration, in the same order,
        /// each with `observed`: whether the CLI declares its records (and so
        /// has a log reader that reports turns), which the other sides read
        /// instead of keeping a list of their own.
        fn launch_values() -> Vec<Value> {
            vec![$({
                let mut value = serde_json::to_value(<crate::vendors::$vendor::V as Vendor>::CLI)
                    .expect("declarations are plain data");
                let observed = <crate::vendors::$vendor::V as Vendor>::OBSERVE.is_some();
                value.as_object_mut().expect("a declaration is an object").insert("observed".into(), Value::Bool(observed));
                value
            }),*]
        }

        /// Call `visitor` once per declared CLI, with its type and the name
        /// of its file under `src/vendors/`.
        pub fn each(visitor: &mut impl Visit) {
            $(visitor.vendor::<crate::vendors::$vendor::V>(stringify!($vendor));)*
        }

        /// The observer of one CLI by key (`None`: unknown, or it declares no records).
        pub fn observer(key: &str) -> Option<AnyObserver> {
            $(
                if <crate::vendors::$vendor::V as Vendor>::CLI.key == key {
                    return Observer::<crate::vendors::$vendor::V>::new().map(AnyObserver::$vendor);
                }
            )*
            None
        }

        /// One CLI's observer, whichever CLI it is.
        #[allow(non_camel_case_types)]
        pub enum AnyObserver {
            $($vendor(Observer<crate::vendors::$vendor::V>)),*
        }

        impl AnyObserver {
            /// An observer for every CLI that declares its records.
            pub fn all() -> Vec<AnyObserver> {
                let mut out = Vec::new();
                $(
                    if let Some(observer) = Observer::<crate::vendors::$vendor::V>::new() {
                        out.push(AnyObserver::$vendor(observer));
                    }
                )*
                out
            }

            pub fn key(&self) -> &'static str {
                match self { $(AnyObserver::$vendor(observer) => observer.key()),* }
            }

            pub fn cwd_form(&self) -> Form {
                match self { $(AnyObserver::$vendor(observer) => observer.spec().cwd_form),* }
            }

            pub fn set_clock(&mut self, now: Option<f64>) {
                match self { $(AnyObserver::$vendor(observer) => observer.set_clock(now)),* }
            }

            pub fn usage(&mut self, path: &Path, checkpoint: &Map<String, Value>) -> Result<UsageRead, Error> {
                match self { $(AnyObserver::$vendor(observer) => observer.usage(path, checkpoint)),* }
            }

            pub fn activity_bag(&mut self, path: &Path, bag: &mut Vec<String>) -> Result<Vec<ActivityEvent>, Error> {
                match self { $(AnyObserver::$vendor(observer) => observer.activity_bag(path, bag)),* }
            }

            pub fn turns(&mut self, path: &Path, session_id: &str) -> Result<Vec<TurnUsage>, Error> {
                match self { $(AnyObserver::$vendor(observer) => observer.turns(path, session_id)),* }
            }

            pub fn take_notes(&mut self) -> Vec<Note> {
                match self { $(AnyObserver::$vendor(observer) => observer.take_notes()),* }
            }

            pub fn take_reads(&mut self) -> Vec<decl::Read> {
                match self { $(AnyObserver::$vendor(observer) => observer.take_reads()),* }
            }
        }
    };
}

each_vendor!(registry);

/// What `declarations launch` prints: the launch and resume part of every
/// declaration, and whether it is observed, as the checked-in
/// `cli_declarations.json` holds it (pretty JSON and a final newline).
pub fn launch_json() -> String {
    let mut text = serde_json::to_string_pretty(&launch_values()).expect("declarations are plain data");
    text.push('\n');
    text
}
