use serde::Serialize;
use thiserror::Error;

/// Structured error codes returned to the frontend / callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NasUnavailable,
    NasAuthRequired,
    NasAuthFailed,
    CategoryNotConfigured,
    TaskNotFound,
    TaskConflict,
    MetaUnparseable,
    ValidationError,
    OccurrenceNotFound,
    StorageError,
    InternalError,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("NAS 不可用: {0}")]
    NasUnavailable(String),

    #[error("尚未授权登录极空间: {0}")]
    NasAuthRequired(String),

    #[error("极空间授权或认证失败: {0}")]
    NasAuthFailed(String),

    #[error("尚未配置专用 Todo 分类: {0}")]
    CategoryNotConfigured(String),

    #[error("任务不存在: {0}")]
    TaskNotFound(i64),

    #[error("任务已在其他设备或极空间中被修改")]
    TaskConflict {
        task_id: i64,
        expected_etag: String,
        actual_etag: String,
    },

    #[error("无法解析任务元数据: {0}")]
    MetaUnparseable(String),

    #[error("参数校验失败: {0}")]
    Validation(String),

    #[error("未找到对应的重复实例: {0}")]
    OccurrenceNotFound(String),

    #[error("本地存储错误: {0}")]
    Storage(String),

    #[error("内部错误: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> ErrorCode {
        match self {
            AppError::NasUnavailable(_) => ErrorCode::NasUnavailable,
            AppError::NasAuthRequired(_) => ErrorCode::NasAuthRequired,
            AppError::NasAuthFailed(_) => ErrorCode::NasAuthFailed,
            AppError::CategoryNotConfigured(_) => ErrorCode::CategoryNotConfigured,
            AppError::TaskNotFound(_) => ErrorCode::TaskNotFound,
            AppError::TaskConflict { .. } => ErrorCode::TaskConflict,
            AppError::MetaUnparseable(_) => ErrorCode::MetaUnparseable,
            AppError::Validation(_) => ErrorCode::ValidationError,
            AppError::OccurrenceNotFound(_) => ErrorCode::OccurrenceNotFound,
            AppError::Storage(_) => ErrorCode::StorageError,
            AppError::Internal(_) => ErrorCode::InternalError,
        }
    }

    pub fn to_payload(&self) -> ErrorPayload {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    pub code: ErrorCode,
    pub message: String,
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Storage(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
