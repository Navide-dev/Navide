//! Windows Hello for Navide App Lock.
//!
//! The Electron main process spawns this once per question and reads the exit
//! code; nothing else crosses the boundary (no PIN, no credential):
//!
//!   navide-hello check                    0 = Windows Hello is set up, 1 = not
//!   navide-hello verify <hwnd> <message>  0 = verified, 1 = refused or cancelled
//!
//! Any other failure exits 2. `verify` parents the system dialog to the given
//! window (Windows 11's IUserConsentVerifierInterop), so it opens in front of
//! Navide instead of behind it. One word on stdout names the outcome for logs.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("check") if args.len() == 1 => hello::check(),
        Some("verify") if args.len() == 3 => match args[1].parse::<usize>() {
            Ok(hwnd) => hello::verify(hwnd, &args[2]),
            Err(_) => Err("bad-hwnd".to_string()),
        },
        _ => Err("usage".to_string()),
    };
    match outcome {
        Ok((true, word)) => {
            println!("{word}");
            ExitCode::from(0)
        }
        Ok((false, word)) => {
            println!("{word}");
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

#[cfg(windows)]
mod hello {
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    pub fn check() -> Result<(bool, &'static str), String> {
        let availability = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.join())
            .map_err(|e| e.to_string())?;
        Ok(match availability {
            UserConsentVerifierAvailability::Available => (true, "available"),
            UserConsentVerifierAvailability::DeviceNotPresent => (false, "device-not-present"),
            UserConsentVerifierAvailability::NotConfiguredForUser => (false, "not-configured"),
            UserConsentVerifierAvailability::DisabledByPolicy => (false, "disabled-by-policy"),
            UserConsentVerifierAvailability::DeviceBusy => (false, "device-busy"),
            _ => (false, "unavailable"),
        })
    }

    pub fn verify(hwnd: usize, message: &str) -> Result<(bool, &'static str), String> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.to_string())?;
        let result = unsafe {
            interop.RequestVerificationForWindowAsync::<IAsyncOperation<UserConsentVerificationResult>>(
                HWND(hwnd as *mut core::ffi::c_void),
                &HSTRING::from(message),
            )
        }
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
        Ok(match result {
            UserConsentVerificationResult::Verified => (true, "verified"),
            UserConsentVerificationResult::Canceled => (false, "canceled"),
            UserConsentVerificationResult::RetriesExhausted => (false, "retries-exhausted"),
            _ => (false, "not-verified"),
        })
    }
}

#[cfg(not(windows))]
mod hello {
    pub fn check() -> Result<(bool, &'static str), String> {
        Ok((false, "unsupported-platform"))
    }

    pub fn verify(_hwnd: usize, _message: &str) -> Result<(bool, &'static str), String> {
        Err("unsupported-platform".to_string())
    }
}
