from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    """Class for request body of qna endpoint"""

    query: str = Field(description="Query to be answered.")
    job_id: str = Field(description="Job ID for the query.")


class SyncFileRequest(BaseModel):
    """Class for single file sync request"""

    rel_filepath: str = Field(description="Relative filepath of the markdown note")
    content: str = Field(description="Raw markdown content of the note")


class DeleteFileRequest(BaseModel):
    """Class for single file delete request"""

    rel_filepath: str = Field(description="Relative filepath of the markdown note to delete")


class UpdateVaultPathRequest(BaseModel):
    """Class for updating local vault path"""

    local_vault_path: str = Field(description="Updated absolute or relative local vault directory path")

