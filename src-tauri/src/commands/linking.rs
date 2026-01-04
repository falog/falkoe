use tauri::AppHandle;

mod cmudict;
mod render;
mod types;

pub use types::RenderLinkingResult;

pub(crate) use cmudict::warmup_cmudict;

#[tauri::command]
pub fn render_linking(
    app: AppHandle,
    text: String,
    linking_mode: Option<bool>,
    display_mode: Option<String>,
    use_dict: Option<bool>,
) -> Result<RenderLinkingResult, String> {
    render::render_linking_impl(app, text, linking_mode, display_mode, use_dict)
}
