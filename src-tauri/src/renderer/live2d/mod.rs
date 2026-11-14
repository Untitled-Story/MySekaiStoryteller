pub mod breath;
pub mod expression;
pub mod eyeblink;
pub mod model;
pub mod motion;

pub use model::Live2DModelInstance;

/// Parameter IDs ignored on track 0 when playing motion without facial track,
/// matching `MOTION_IGNORE_EYE_PARAMS` in `src/story/scene.ts`.
pub const MOTION_IGNORE_EYE_PARAMS: &[&str] = &[
    "ParamEyeROpen",
    "ParamEyeLOpen",
    "ParamEyeballX",
    "ParamEyeballY",
];

/// Parameter IDs ignored on track 0 when playing motion together with a facial motion,
/// matching `MOTION_IGNORE_FACE_PARAMS` in `src/story/scene.ts`.
pub const MOTION_IGNORE_FACE_PARAMS: &[&str] = &[
    "ParamEyeROpen",
    "ParamEyeLOpen",
    "ParamEyeballX",
    "ParamEyeballY",
    "ParamBrowRX",
    "ParamBrowRY",
    "ParamBrowRAngle",
    "ParamBrowRForm",
    "ParamBrowLX",
    "ParamBrowLY",
    "ParamBrowLAngle",
    "ParamBrowLForm",
    "ParamEyeRSmile",
    "ParamEyeRForm",
    "ParamEyeLSmile",
    "ParamEyeLForm",
    "ParamEyeSize",
    "ParamEyeTeary",
    "ParamTear",
    "ParamMouthForm",
    "ParamMouthOpenY",
    "ParamMouthForm2",
    "ParamTeeth",
    "ParamMouthScaleX",
    "ParamMouthScaleY",
    "ParamMouthPositionY",
    "ParamCheek",
    "ParamFaceShadow",
    "ParamSweatOn",
    "ParamSweatMove",
    "ParamCheekAngry",
];

/// Matches `src/lib/live2d.ts` `breathDepth: 0`.
pub const BREATH_DEPTH: f32 = 0.0;
/// Matches `untitled-pixi-live2d-engine` default `lipSyncGain: 1.5`.
pub const LIP_SYNC_GAIN: f32 = 1.5;
/// Matches `untitled-pixi-live2d-engine` `lipSyncWeight: 0.4`.
pub const LIP_SYNC_WEIGHT: f32 = 0.4;
/// Matches `untitled-pixi-live2d-engine` `config.motionFadingDuration = 500` ms.
pub const DEFAULT_MOTION_FADE_SECONDS: f32 = 0.5;
