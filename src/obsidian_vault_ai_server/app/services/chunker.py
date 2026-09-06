from langchain_text_splitters import RecursiveCharacterTextSplitter

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=2000, # chunks with 1000 characters in size
    chunk_overlap=400, # with a overlap of 200 character.
)

def chunk_text(text:str) -> list[str]:
    """
    Splits the given text into overlapping chunks for RAG. 
    """

    return text_splitter.split_text(text)