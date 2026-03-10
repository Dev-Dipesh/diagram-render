# Example — multiple diagrams in one markdown file

## Sequence diagram (titled)

```plantuml request-flow
@startuml
actor User
participant "Your System" as S
participant "External API" as API

User -> S: request
S -> API: fetch data
API --> S: response
S --> User: result
@enduml
```

## Flow diagram (titled)

```mermaid decision-flow
graph TD
    A[Start] --> B{Decision}
    B -- Yes --> C[Do thing]
    B -- No --> D[Skip]
    C --> E[End]
    D --> E
```

## Untitled (falls back to type-sequence name)

```mermaid
graph LR
    A --> B --> C
```
