from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    """Class for request body of qna endpoint"""

    query: str = Field(description="Query to be answered.")
    job_id: str = Field(description="Job ID for the query.")
