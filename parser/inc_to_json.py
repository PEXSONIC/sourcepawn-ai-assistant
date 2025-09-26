import os
import re
import json
import argparse
from typing import List, Dict, Any, Tuple, Optional

# Matches: native, stock, forward, public
# Captures: type, return_type, name, params
FUNC_REGEX = re.compile(
    r"^(?P<type>native|stock|forward|public)\s+"
    r"(?:New:\s*)?"  # Optional "New:" keyword
    r"(?P<return_type>[\w:<>\[\]]+)\s+"  # Return type (e.g., void, int, Handle, Action)
    r"(?P<name>\w+)\s*"
    r"\((?P<params>.*?)\);"
    , re.MULTILINE | re.DOTALL)

# Matches methodmap declarations
# Captures: name, inherits (optional)
METHODMAP_REGEX = re.compile(
    r"^methodmap\s+(?P<name>\w+)(?:\s*<\s*(?P<inherits>\w+))?"
)

# Matches properties inside a methodmap
# Captures: name, property_type
PROPERTY_REGEX = re.compile(r"^\s*public\s+property\s+(?P<property_type>\w+)\s+(?P<name>\w+)")

# Matches constants, enums, and typedefs
CONST_REGEX = re.compile(r"^\s*const\s+\w+\s+(?P<name>\w+)\s*=\s*.*?;")
ENUM_REGEX = re.compile(r"^\s*enum\s+(?P<name>\w+)\s*\{")
TYPEDEF_REGEX = re.compile(r"^\s*typedef\s+(?P<name>\w+)\s*=\s*function\s+(?P<return_type>[\w:]+)\s*\((?P<params>.*?)\);")


def parse_comment_block(comment_lines: List[str]) -> Dict[str, Any]:
    """
    Parses a documentation comment block into a structured dictionary.
    This translates the logic of ParseCommentBlock, SplitCommentBlock, and ParseTags.
    """
    # Clean the comment lines
    clean_lines = []
    for line in comment_lines:
        line = line.strip()
        if line.startswith('/**'):
            line = line[3:]
        if line.endswith('*/'):
            line = line[:-2]
        if line.startswith('*'):
            line = line[1:]
        clean_lines.append(line.strip())

    full_comment = "\n".join(clean_lines).strip()

    # Split description from tags
    parts = re.split(r'\n\s*@', full_comment, 1)
    description = parts[0].strip()
    
    tags_str = ''
    if len(parts) > 1:
        tags_str = '@' + parts[1]

    # Parse tags
    tags = {
        'param': [],
        'error': [],
        'note': [],
        'return': ''
    }
    
    # Use regex to find all tags and their content
    tag_matches = re.finditer(r"(@(?P<tag>\w+))\s*(?P<content>.*?)(?=\n\s*@|$)", tags_str, re.DOTALL)
    for match in tag_matches:
        tag_name = match.group('tag')
        content = ' '.join(line.strip() for line in match.group('content').strip().split('\n'))

        if tag_name == 'param':
            param_match = re.match(r"(?P<name>\w+)\s*(?P<desc>.*)", content)
            if param_match:
                tags['param'].append({
                    'name': param_match.group('name'),
                    'description': param_match.group('desc').strip()
                })
        elif tag_name == 'return':
            tags['return'] = content
        elif tag_name in ['error', 'note', 'deprecated', 'see', 'author']:
             tags.setdefault(tag_name, []).append(content)

    return {"description": description, "tags": tags}


def parse_params_string(params_str: str, parsed_comment: Dict[str, Any]) -> List[Dict[str, str]]:
    """Parses the parameter string from a function declaration."""
    if not params_str.strip():
        return []

    param_list = []
    # Split params by comma, but be careful about commas inside potential future syntax
    params = params_str.split(',')
    
    comment_params = {p['name']: p['description'] for p in parsed_comment['tags']['param']}

    for param in params:
        param = param.strip()
        if not param:
            continue
        
        # Regex to capture type, name, and optional default value
        match = re.match(
            r"(?:const\s+)?(?P<type>[\w:\[\]]+)\s+&?(?P<name>\w+)(?:\s*=\s*(?P<default>.*?))?",
            param
        )
        if match:
            p_data = match.groupdict()
            param_list.append({
                "name": p_data['name'],
                "type": p_data['type'],
                "default": p_data.get('default', None),
                "description": comment_params.get(p_data['name'], "")
            })

    return param_list


def parse_include_file(filepath: str, filename: str) -> List[Dict[str, Any]]:
    """
    Parses an entire .inc file, managing state to link comments with declarations.
    This is the main state machine, equivalent to the main loop in the PHP script.
    """
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # Normalize line endings
    content = content.replace('\r\n', '\n').replace('\r', '\n')
    
    api_entries = []
    
    # Find all comment blocks and the code that follows them
    # This is a more robust approach than line-by-line state management
    # It finds a comment block and captures the text until the next comment block or end of file
    comment_and_code_blocks = re.finditer(
        r"(?P<comment>/\*\*.+?\*/)\s*(?P<code>.*?)(?=/\*\*|$)",
        content,
        re.DOTALL
    )

    for block in comment_and_code_blocks:
        comment_text = block.group('comment')
        code_text = block.group('code')
        
        parsed_comment = parse_comment_block(comment_text.split('\n'))
        
        # --- Try to match different declaration types in the code block ---
        
        # 1. Functions (native, stock, forward)
        func_match = FUNC_REGEX.search(code_text)
        if func_match:
            data = func_match.groupdict()
            entry = {
                "name": data['name'],
                "type": data['type'],
                "source_file": filename,
                "return_type": data['return_type'],
                "comment": parsed_comment['description'],
                "tags": parsed_comment['tags'],
                "params": parse_params_string(data['params'], parsed_comment),
                "full_declaration": func_match.group(0).strip().replace('\n', ' ')
            }
            api_entries.append(entry)
            continue # Move to next block

        # 2. Methodmaps
        methodmap_match = METHODMAP_REGEX.search(code_text)
        if methodmap_match:
            data = methodmap_match.groupdict()
            # Find the full methodmap block
            full_map_match = re.search(r"methodmap\s+.+?\{(.+?)\n\};", code_text, re.DOTALL)
            methods = []
            properties = []

            if full_map_match:
                map_body = full_map_match.group(1)
                # Find functions inside the methodmap
                map_funcs = FUNC_REGEX.finditer(map_body)
                for map_func in map_funcs:
                    m_data = map_func.groupdict()
                    methods.append({
                        "name": m_data['name'],
                        "type": m_data['type'],
                        "return_type": m_data['return_type'],
                        "params": parse_params_string(m_data['params'], {"tags":{"param":[]}}), # Comments are not per-method
                        "full_declaration": map_func.group(0).strip().replace('\n', ' ')
                    })
                # Find properties
                map_props = PROPERTY_REGEX.finditer(map_body)
                for map_prop in map_props:
                    p_data = map_prop.groupdict()
                    properties.append({
                        "name": p_data['name'],
                        "type": p_data['property_type']
                    })

            entry = {
                "name": data['name'],
                "type": "methodmap",
                "source_file": filename,
                "inherits": data.get('inherits'),
                "comment": parsed_comment['description'],
                "tags": parsed_comment['tags'],
                "methods": methods,
                "properties": properties,
                "full_declaration": methodmap_match.group(0).strip()
            }
            api_entries.append(entry)
            continue
            
        # 3. Typedefs / Functags
        typedef_match = TYPEDEF_REGEX.search(code_text)
        if typedef_match:
            data = typedef_match.groupdict()
            entry = {
                "name": data['name'],
                "type": "typedef",
                "source_file": filename,
                "return_type": data['return_type'],
                "comment": parsed_comment['description'],
                "tags": parsed_comment['tags'],
                "params": parse_params_string(data['params'], parsed_comment),
                "full_declaration": typedef_match.group(0).strip()
            }
            api_entries.append(entry)
            continue

    return api_entries


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(description="Parse SourceMod includes into a JSON API file for AI Function Calling.")
    parser.add_argument("include_dir", help="Path to the SourceMod 'include' directory.")
    parser.add_argument("-o", "--output", default="sourcemod_api.json", help="Path to the output JSON file.")
    args = parser.parse_args()

    if not os.path.isdir(args.include_dir):
        print(f"Error: Directory not found at '{args.include_dir}'")
        return

    all_api_data = []
    print(f"Scanning for .inc files in '{args.include_dir}'...")

    for root, _, files in os.walk(args.include_dir):
        for file in files:
            if file.endswith('.inc'):
                filepath = os.path.join(root, file)
                print(f"  -> Parsing {file}...")
                try:
                    entries = parse_include_file(filepath, file)
                    if entries:
                        all_api_data.extend(entries)
                except Exception as e:
                    print(f"    !! Failed to parse {file}: {e}")

    print(f"\nSuccessfully parsed {len(all_api_data)} API entries.")

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(all_api_data, f, indent=2)

    print(f"API data has been written to '{args.output}'")


if __name__ == "__main__":
    main()
